/**
 * The Social Club website Worker.
 *
 * Static files in /public are served directly by Workers Static Assets.
 * This script only runs for /api/* (see run_worker_first in wrangler.jsonc):
 *
 *   POST /api/contact   Validates the contact form and emails it through Resend.
 *   GET  /api/config    Public, non secret client config (Turnstile site key).
 *
 * Configuration (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
 *   RESEND_API_KEY        secret, required to send mail
 *   CONTACT_TO            var, inbox that receives submissions
 *   CONTACT_FROM          var, verified Resend sender, e.g. "The Social Club <website@forms.thesocialclubkids.com>"
 *   TURNSTILE_SITE_KEY    var, optional, enables Cloudflare Turnstile on the form
 *   TURNSTILE_SECRET_KEY  secret, optional, required when TURNSTILE_SITE_KEY is set
 *   ALLOWED_ORIGINS       var, optional comma separated list of extra allowed origins
 */

const MAX_BODY_BYTES = 32 * 1024;
const MIN_FILL_MS = 2500;
const PROGRAMS = new Set([
  'Not sure yet',
  "Kid's Club",
  'Pre Teen Club',
  'Teen Club',
  'Young Adult Club',
  'Social Club in School',
]);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE_RE = /^[0-9+().\s\-xX]{7,40}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      try {
        return await handleContact(request, env, url);
      } catch (err) {
        console.error('contact handler failed', err && err.stack ? err.stack : err);
        return respond(request, 500, { ok: false, error: 'Unexpected server error.' });
      }
    }

    if (url.pathname === '/api/config') {
      return json(200, { turnstileSiteKey: env.TURNSTILE_SITE_KEY || null }, {
        'Cache-Control': 'public, max-age=300',
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return json(404, { ok: false, error: 'Not found.' });
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleContact(request, env, url) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' }, { Allow: 'POST' });
  }

  // Only accept submissions that come from this site.
  if (!originAllowed(request, env, url)) {
    return json(403, { ok: false, error: 'Forbidden.' });
  }

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) {
    return respond(request, 413, { ok: false, error: 'Your message is too large.' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.CONTACT_LIMITER) {
    const { success } = await env.CONTACT_LIMITER.limit({ key: `contact:${ip}` });
    if (!success) {
      return respond(request, 429, { ok: false, error: 'Too many messages. Please try again in a minute.' });
    }
  }

  let raw;
  try {
    raw = await readBody(request);
  } catch {
    return respond(request, 400, { ok: false, error: 'Could not read your message.' });
  }

  // Bots: honeypot filled in, or the form was sent faster than a person could type.
  // Pretend success so they learn nothing.
  const startedAt = Number(raw.t || 0);
  if (clean(raw.website, 200) || (startedAt && Date.now() - startedAt < MIN_FILL_MS)) {
    return respond(request, 200, { ok: true });
  }

  const data = {
    name: singleLine(clean(raw.name, 100)),
    email: singleLine(clean(raw.email, 254)),
    phone: singleLine(clean(raw.phone, 40)),
    program: singleLine(clean(raw.program, 60)) || 'Not sure yet',
    age: singleLine(clean(raw.age, 20)),
    message: clean(raw.message, 5000),
  };

  const fields = validate(data);
  if (Object.keys(fields).length) {
    return respond(request, 422, { ok: false, error: 'Please check the highlighted fields.', fields });
  }

  if (env.TURNSTILE_SECRET_KEY) {
    const token = clean(raw.turnstileToken || raw['cf-turnstile-response'], 2048);
    const passed = token && (await verifyTurnstile(token, ip, env.TURNSTILE_SECRET_KEY));
    if (!passed) {
      return respond(request, 400, { ok: false, error: 'We could not verify that you are human. Please try again.' });
    }
  }

  if (!env.RESEND_API_KEY || !env.CONTACT_TO || !env.CONTACT_FROM) {
    console.error('Contact form is not configured: set RESEND_API_KEY, CONTACT_TO and CONTACT_FROM.');
    return respond(request, 503, { ok: false, error: 'The contact form is not available right now.' });
  }

  const sent = await sendEmail(env, data, request);
  if (!sent) {
    return respond(request, 502, { ok: false, error: 'Your message could not be delivered.' });
  }

  return respond(request, 200, { ok: true });
}

function originAllowed(request, env, url) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    // Older browsers may omit Origin on same origin form posts; fall back to Sec-Fetch-Site.
    const site = request.headers.get('Sec-Fetch-Site');
    return !site || site === 'same-origin' || site === 'none';
  }
  const allowed = new Set([url.origin]);
  (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((o) => allowed.add(o));
  return allowed.has(origin);
}

async function readBody(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('too large');
  if (type.includes('application/json')) {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad json');
    return parsed;
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  throw new Error('unsupported content type');
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // Drop control characters except tab and newline, normalize line endings, trim.
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function singleLine(value) {
  return value.replace(/\s+/g, ' ');
}

function validate(d) {
  const f = {};
  if (!d.name) f.name = 'Please enter your name.';
  if (!d.email) f.email = 'Please enter your email address.';
  else if (!EMAIL_RE.test(d.email)) f.email = 'Please enter a valid email address, like name@example.com.';
  if (d.phone && (!PHONE_RE.test(d.phone) || (d.phone.match(/\d/g) || []).length < 7)) {
    f.phone = 'Please enter a valid phone number, or leave this field blank.';
  }
  if (!PROGRAMS.has(d.program)) d.program = 'Not sure yet';
  if (!d.message) f.message = 'Please tell us a little about how we can help.';
  else if (d.message.length < 10) f.message = 'Please add a few more details, at least 10 characters.';
  return f;
}

async function verifyTurnstile(token, ip, secret) {
  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', token);
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const out = await res.json();
    return Boolean(out && out.success);
  } catch (err) {
    console.error('turnstile verification failed', err);
    return false;
  }
}

async function sendEmail(env, d, request) {
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' });
  const rows = [
    ['Name', d.name],
    ['Email', d.email],
    ['Phone', d.phone || 'Not provided'],
    ['Program', d.program],
    ["Child's age", d.age || 'Not provided'],
  ];

  const text = [
    'New message from thesocialclubkids.com',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'Message:',
    d.message,
    '',
    `Sent ${when} (Pacific)`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#0f0f0e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px">
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#5d5c56">Website contact form</p>
      <h1 style="margin:0;font-size:24px;line-height:1.2">New message from ${esc(d.name)}</h1>
    </td></tr>
    <tr><td style="padding:16px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#5d5c56;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-weight:bold">${esc(v)}</td></tr>`).join('')}
      </table>
    </td></tr>
    <tr><td style="padding:8px 28px 28px">
      <p style="margin:0 0 8px;color:#5d5c56;font-size:13px;letter-spacing:1px;text-transform:uppercase">Message</p>
      <div style="font-size:16px;line-height:1.6;white-space:pre-wrap">${esc(d.message)}</div>
      <p style="margin:24px 0 0;color:#5d5c56;font-size:13px">Sent ${esc(when)} (Pacific). Reply to this email to respond directly.</p>
    </td></tr>
  </table></body></html>`;

  const to = env.CONTACT_TO.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `tsc-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      from: env.CONTACT_FROM,
      to,
      reply_to: d.email,
      subject: `New website message from ${d.name}`,
      text,
      html,
      tags: [{ name: 'source', value: 'website_contact' }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('resend send failed', res.status, detail.slice(0, 500));
    return false;
  }
  return true;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wantsJson(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  const accept = (request.headers.get('Accept') || '').toLowerCase();
  return type.includes('application/json') || accept.includes('application/json');
}

// JSON for the enhanced form; a redirect or simple page for the no JavaScript fallback.
function respond(request, status, payload) {
  if (wantsJson(request)) return json(status, payload);
  if (payload.ok) {
    return new Response(null, { status: 303, headers: { Location: '/thanks/', 'Cache-Control': 'no-store' } });
  }
  const msg = esc(payload.error || 'Something went wrong.');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Message not sent: The Social Club</title><link rel="stylesheet" href="/assets/css/main.css"></head><body><main id="main" class="page-simple"><div><h1>Message not sent.</h1><p>${msg} You can also email <a href="mailto:contact@thesocialclubkids.com">contact@thesocialclubkids.com</a> or call <a href="tel:+16267651724">(626) 765 1724</a>.</p><a class="btn btn--ink" href="/#contact"><span>Back to the form</span></a></div></main></body></html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function json(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}
