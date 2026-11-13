/**
 * The Social Club website Worker.
 *
 * Static files in /public are served directly by Workers Static Assets.
 * This script only runs for /api/* (see run_worker_first in wrangler.jsonc):
 *
 *   POST /api/contact               Validates the contact form and emails it through Resend.
 *   GET  /api/config                Public, non secret client config (Turnstile site key).
 *   GET  /api/instagram             Latest posts from @thesocialclubkids (cached), read from
 *                                   Behold or, failing that, straight from the Instagram API.
 *   GET  /api/instagram/media/:id   Image for one of those posts, proxied so the CSP stays 'self'.
 *   Cron (weekly)                   Keeps the feed warm and, when an Instagram token is used,
 *                                   refreshes it before its 60 day expiry.
 *
 * The contact form only collects name, email, phone and program of interest. It has
 * no free text field on purpose: Resend and Cloudflare (below Enterprise) will not sign
 * a HIPAA Business Associate Agreement, so the form must not invite health details.
 *
 * Configuration (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
 *   RESEND_API_KEY        secret, required to send mail
 *   CONTACT_TO            var, inbox that receives submissions
 *   CONTACT_FROM          var, verified Resend sender, e.g. "The Social Club <website@forms.thesocialclubkids.com>"
 *   TURNSTILE_SITE_KEY    var, optional, enables Cloudflare Turnstile on the form
 *   TURNSTILE_SECRET_KEY  secret, optional, required when TURNSTILE_SITE_KEY is set
 *   ALLOWED_ORIGINS       var, optional comma separated list of extra allowed origins
 *   BEHOLD_FEED_ID        var, optional, id (or URL) of a Behold JSON feed: the simple way to
 *                         turn on the Instagram feed
 *   INSTAGRAM_TOKEN       secret, optional, Instagram API (Instagram Login) long lived token,
 *                         used only when BEHOLD_FEED_ID is empty
 *   INSTAGRAM             KV binding, stores the cached feed and the refreshed token
 */

const MAX_BODY_BYTES = 32 * 1024;
const MIN_FILL_MS = 2500;
const PROGRAMS = new Set([
  'Not sure yet',
  "Kid's Club",
  'Pre-Teen Club',
  'Teen Club',
  'Social Club in School',
  'Social Skills Individual (1:1)',
  'Facilitated Playdates (2:1)',
]);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE_RE = /^[0-9+().\s\-xX]{7,40}$/;

export default {
  async fetch(request, env, ctx) {
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

    if (url.pathname === '/api/instagram') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      }
      return instagramFeed(env, ctx);
    }

    const media = url.pathname.match(/^\/api\/instagram\/media\/(\d{1,30})$/);
    if (media) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      }
      return instagramMedia(request, env, ctx, media[1]);
    }

    if (url.pathname.startsWith('/api/')) {
      return json(404, { ok: false, error: 'Not found.' });
    }

    return env.ASSETS.fetch(request);
  },

  // Weekly cron (see wrangler.jsonc): keep the Instagram token alive and the feed warm.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await refreshInstagramToken(env);
      await loadFeed(env, { force: true }).catch((err) => console.error('instagram refresh failed', err && err.message ? err.message : err));
    })());
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
    return respond(request, 413, { ok: false, error: 'Your submission is too large.' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.CONTACT_LIMITER) {
    const { success } = await env.CONTACT_LIMITER.limit({ key: `contact:${ip}` });
    if (!success) {
      return respond(request, 429, { ok: false, error: 'Too many submissions. Please try again in a minute.' });
    }
  }

  let raw;
  try {
    raw = await readBody(request);
  } catch {
    return respond(request, 400, { ok: false, error: 'Could not read your submission.' });
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
  };
  // Any other fields (for example an old cached copy of the form that still had a
  // message box) are ignored on purpose and never emailed.

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
    return respond(request, 502, { ok: false, error: 'Your submission could not be delivered.' });
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
    ['Program of interest', d.program],
  ];

  const text = [
    'New inquiry from thesocialclubkids.com',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Sent ${when} (Pacific)`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#0f0f0e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px">
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#5d5c56">Website contact form</p>
      <h1 style="margin:0;font-size:24px;line-height:1.2">New inquiry from ${esc(d.name)}</h1>
    </td></tr>
    <tr><td style="padding:16px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#5d5c56;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-weight:bold">${esc(v)}</td></tr>`).join('')}
      </table>
    </td></tr>
    <tr><td style="padding:8px 28px 28px">
      <p style="margin:0;color:#5d5c56;font-size:13px">Sent ${esc(when)} (Pacific). Reply to this email to respond directly.</p>
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
      subject: `New website inquiry from ${d.name}`,
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
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not sent: The Social Club</title><link rel="stylesheet" href="/assets/css/main.css"></head><body><main id="main" class="page-simple"><div><h1>Oops!</h1><p>Something went wrong while submitting the form. ${msg} You can also email <a href="mailto:contact@thesocialclubkids.com">Contact@TheSocialClubKids.com</a> or call <a href="tel:+16267651724">(626) 765-1724</a>.</p><a class="btn btn--ink" href="/#contact"><span>Back to the form</span></a></div></main></body></html>`;
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

/* Instagram feed
 *
 * The posts come from one of two places:
 *
 * 1. Behold (behold.so), when BEHOLD_FEED_ID is set. Behold holds the connection to the
 *    Instagram account and hands the posts over as JSON, so there is no token to look
 *    after. This is the setup the README describes.
 * 2. The Instagram API with Instagram Login, when only the INSTAGRAM_TOKEN secret is set
 *    (a long lived token with the instagram_business_basic permission). The weekly cron
 *    refreshes the token (it lasts 60 days) and stores the new one in KV together with a
 *    fingerprint of the secret, so replacing the secret later always wins over an older
 *    refreshed token.
 *
 * Feed: cached in KV. A stale copy is served immediately while a fresh one is fetched in
 * the background, and is kept for a while if the source is unreachable.
 */
const IG_API = 'https://graph.instagram.com';
const IG_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
const IG_LIMIT = 12;
const BEHOLD_API = 'https://feeds.behold.so';
const IG_TOKEN_KEY = 'ig:token';
const IG_FEED_KEY = 'ig:feed:v2';
// After a refresh starts or fails, page views wait this long before asking the source again.
const IG_RETRY_MS = 30 * 60 * 1000;
// How long a copy counts as fresh, and how long it is kept when the source cannot be reached.
// Behold: its free plan picks up new posts once a day and counts every request for the feed
// as a "view" (1,200 a month, then the account pauses until the next month), so ask every
// four hours: under 200 requests a month however busy the site is. Its images are its own
// copies rather than Instagram's expiring links, so the last good copy is kept for a week.
// Instagram: image links expire, so the copy is refreshed hourly and kept for a day.
const IG_SOURCES = {
  behold: { freshMs: 4 * 60 * 60 * 1000, keepSeconds: 7 * 24 * 60 * 60 },
  instagram: { freshMs: 60 * 60 * 1000, keepSeconds: 24 * 60 * 60 },
};
const IG_MEDIA_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|behold\.pictures)$/i;
// When this isolate last started a refresh, per source. It backs up the note kept in KV,
// which requests arriving at the same moment (or within KV's one minute read cache) miss.
const igLastRefreshStart = {};

async function instagramFeed(env, ctx) {
  let feed = null;
  try {
    feed = await loadFeed(env, { ctx });
  } catch (err) {
    console.error('instagram feed failed', err && err.message ? err.message : err);
  }
  if (!feed || !feed.posts.length) {
    // Not configured or unavailable: the page keeps its built in photos.
    return json(200, { ok: false, posts: [] }, { 'Cache-Control': 'public, max-age=300' });
  }
  const posts = feed.posts.map((p) => ({
    id: p.id,
    href: p.permalink,
    img: `/api/instagram/media/${p.id}`,
    alt: p.alt,
    type: p.type,
    date: p.timestamp,
  }));
  return json(200, { ok: true, posts }, { 'Cache-Control': 'public, max-age=600' });
}

async function instagramMedia(request, env, ctx, id) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL(`/api/instagram/media/${id}`, request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let feed = null;
  try {
    // The stored copy is enough here: only the feed request itself refreshes it.
    feed = await loadFeed(env, { ctx, refresh: false });
  } catch (err) {
    console.error('instagram media lookup failed', err && err.message ? err.message : err);
  }
  const post = feed && feed.posts.find((p) => p.id === id);
  if (!post) return json(404, { ok: false, error: 'Not found.' });

  let src;
  try {
    src = new URL(post.src);
  } catch {
    return json(404, { ok: false, error: 'Not found.' });
  }
  // Only ever fetch Instagram's or Behold's own image CDN.
  if (src.protocol !== 'https:' || !IG_MEDIA_HOSTS.test(src.hostname)) {
    return json(404, { ok: false, error: 'Not found.' });
  }

  let upstream;
  try {
    upstream = await fetch(src.toString(), { headers: { Accept: 'image/avif,image/webp,image/jpeg,image/*' } });
  } catch (err) {
    console.error('instagram media fetch failed', err && err.message ? err.message : err);
    return json(502, { ok: false, error: 'Image unavailable.' });
  }
  const type = (upstream.headers.get('Content-Type') || '').toLowerCase();
  if (!upstream.ok || !type.startsWith('image/')) {
    return json(502, { ok: false, error: 'Image unavailable.' });
  }

  const response = new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
  if (cache) {
    const copy = response.clone();
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, copy));
    else await cache.put(cacheKey, copy);
  }
  return response;
}

// Accepts the bare feed id or the whole feed URL (https://feeds.behold.so/<id>).
function beholdFeedId(env) {
  const match = String(env.BEHOLD_FEED_ID || '').trim().match(/([A-Za-z0-9_-]{8,64})\/?$/);
  return match ? match[1] : '';
}

function feedSource(env) {
  if (beholdFeedId(env)) {
    // Without the KV cache every page view would count against Behold's monthly allowance.
    if (env.INSTAGRAM) return 'behold';
    console.error('instagram feed: BEHOLD_FEED_ID is set but the INSTAGRAM KV binding is missing');
    return '';
  }
  return env.INSTAGRAM_TOKEN ? 'instagram' : '';
}

// The stored copy for this source, or null. Past its keep time the posts are dropped,
// but the record still says when the source was last tried.
async function storedFeed(env, source) {
  if (!env.INSTAGRAM) return null;
  let record = null;
  try {
    record = await env.INSTAGRAM.get(IG_FEED_KEY, 'json');
  } catch {
    record = null;
  }
  if (!record || record.source !== source || !Array.isArray(record.posts)) return null;
  if (Date.now() - (record.fetchedAt || 0) > IG_SOURCES[source].keepSeconds * 1000) {
    return { ...record, fetchedAt: 0, posts: [] };
  }
  return record;
}

// Returns { source, fetchedAt, posts } or null when no source is configured.
// refresh: false returns the stored copy however old it is (used for images).
async function loadFeed(env, { ctx = null, force = false, refresh = true } = {}) {
  const source = feedSource(env);
  if (!source) return null;
  const cached = await storedFeed(env, source);

  if (!force) {
    const now = Date.now();
    const lastTry = Math.max(cached ? cached.triedAt || 0 : 0, igLastRefreshStart[source] || 0);
    const triedLately = now - lastTry < IG_RETRY_MS;
    if (cached) {
      const fresh = now - cached.fetchedAt < IG_SOURCES[source].freshMs;
      if (!refresh || fresh || triedLately) return cached;
      if (cached.posts.length && ctx && ctx.waitUntil) {
        // Serve the stale copy now and refresh it in the background.
        ctx.waitUntil(refreshFeed(env, source, cached).catch((err) => console.error('instagram refresh failed', err && err.message ? err.message : err)));
        return cached;
      }
    } else if (triedLately) {
      return null;
    }
  }

  try {
    return await refreshFeed(env, source, cached);
  } catch (err) {
    if (!cached) throw err;
    console.error('instagram refresh failed', err && err.message ? err.message : err);
    return cached;
  }
}

async function refreshFeed(env, source, cached) {
  igLastRefreshStart[source] = Date.now();
  const kv = env.INSTAGRAM || null;
  const { keepSeconds } = IG_SOURCES[source];
  const base = cached || { source, fetchedAt: 0, posts: [] };
  if (kv) {
    // Note the attempt first, so page views that arrive meanwhile, or after a failure,
    // wait for IG_RETRY_MS instead of each asking the source again.
    const until = Math.max(Math.floor(Date.now() / 1000) + 3600, Math.floor(base.fetchedAt / 1000) + keepSeconds);
    await kv.put(IG_FEED_KEY, JSON.stringify({ ...base, triedAt: Date.now() }), { expiration: until }).catch(() => {});
  }
  const posts = source === 'behold' ? await fetchBeholdPosts(env) : await fetchInstagramPosts(env);
  const feed = { source, fetchedAt: Date.now(), posts };
  if (kv) {
    await kv.put(IG_FEED_KEY, JSON.stringify(feed), { expirationTtl: keepSeconds });
  }
  return feed;
}

async function fetchBeholdPosts(env) {
  const res = await fetch(`${BEHOLD_API}/${beholdFeedId(env)}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !Array.isArray(body.posts)) {
    const detail = body && typeof (body.error || body.message) === 'string' ? (body.error || body.message).slice(0, 200) : '';
    throw new Error(`behold feed request failed: ${res.status} ${detail}`.trim());
  }
  return body.posts.map(beholdPost).filter(Boolean).slice(0, IG_LIMIT);
}

function beholdPost(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '');
  if (!/^\d{1,30}$/.test(id) || typeof p.permalink !== 'string') return null;
  if (!/^https:\/\/(www\.)?instagram\.com\//.test(p.permalink)) return null;
  // Behold's resized copy (about 1000px on the long side) rather than Instagram's original.
  // Videos and reels come with a still image; albums use their first item.
  const first = Array.isArray(p.children) ? p.children[0] : null;
  const src = sizedImage(p.sizes) || sizedImage(first && first.sizes)
    || (p.mediaType === 'VIDEO' ? p.thumbnailUrl : p.mediaUrl);
  if (typeof src !== 'string' || !src) return null;
  return {
    id,
    permalink: p.permalink,
    src,
    type: typeof p.mediaType === 'string' ? p.mediaType : 'IMAGE',
    timestamp: typeof p.timestamp === 'string' ? p.timestamp : null,
    alt: ownAltText(p.altText) || altFromCaption(p.prunedCaption || p.caption, p.mediaType),
  };
}

function sizedImage(sizes) {
  if (!sizes || typeof sizes !== 'object') return '';
  const size = [sizes.large, sizes.medium, sizes.full, sizes.small].find((s) => s && typeof s.mediaUrl === 'string' && s.mediaUrl);
  return size ? size.mediaUrl : '';
}

// The alt text written on Instagram itself, tidied to one line.
function ownAltText(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, '')}...` : text;
}

async function fetchInstagramPosts(env) {
  const token = await instagramToken(env);
  const url = `${IG_API}/me/media?fields=${IG_FIELDS}&limit=${IG_LIMIT}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body.data)) {
    const detail = body && body.error ? `${body.error.code || ''} ${body.error.message || ''}` : res.status;
    throw new Error(`instagram media request failed: ${detail}`);
  }
  return body.data
    .map((m) => {
      const src = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
      if (!m.id || !/^\d{1,30}$/.test(String(m.id)) || !src || typeof m.permalink !== 'string') return null;
      if (!/^https:\/\/(www\.)?instagram\.com\//.test(m.permalink)) return null;
      return {
        id: String(m.id),
        permalink: m.permalink,
        src,
        type: m.media_type,
        timestamp: m.timestamp || null,
        alt: altFromCaption(m.caption, m.media_type),
      };
    })
    .filter(Boolean);
}

// A short, readable description from the caption: first sentence, no hashtags or mentions.
function altFromCaption(caption, type) {
  const fallback = type === 'VIDEO' ? 'Video from The Social Club on Instagram' : 'Photo from The Social Club on Instagram';
  if (typeof caption !== 'string') return fallback;
  let text = caption
    .replace(/[#@][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  const sentence = text.match(/^.{20,}?[.!?](\s|$)/);
  if (sentence) text = sentence[0].trim();
  if (text.length > 140) text = `${text.slice(0, 137).replace(/\s+\S*$/, '')}...`;
  return text;
}

async function secretFingerprint(secret) {
  if (!secret) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function instagramToken(env) {
  const seed = env.INSTAGRAM_TOKEN || '';
  if (!env.INSTAGRAM) return seed;
  let stored = null;
  try {
    stored = await env.INSTAGRAM.get(IG_TOKEN_KEY, 'json');
  } catch {
    stored = null;
  }
  if (stored && stored.token && stored.seed === (await secretFingerprint(seed))) return stored.token;
  return seed;
}

async function refreshInstagramToken(env) {
  if (!env.INSTAGRAM) return false;
  const token = await instagramToken(env);
  if (!token) return false;
  const res = await fetch(`${IG_API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const detail = body && body.error ? `${body.error.code || ''} ${body.error.message || ''}` : res.status;
    console.error('instagram token refresh failed', detail);
    return false;
  }
  await env.INSTAGRAM.put(IG_TOKEN_KEY, JSON.stringify({
    token: body.access_token,
    seed: await secretFingerprint(env.INSTAGRAM_TOKEN || ''),
    refreshedAt: new Date().toISOString(),
    expiresIn: body.expires_in || null,
  }));
  return true;
}
