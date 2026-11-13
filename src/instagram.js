/**
 * Instagram feed for the home page (Instagram API with Instagram Login).
 *
 *   GET /api/instagram              Recent posts as JSON for the "Follow the fun" section.
 *   GET /api/instagram/media/<id>   One post image, proxied through this Worker.
 *
 * Visitors only ever talk to this site: images are proxied, so the strict Content Security
 * Policy stays as it is and no visitor data reaches Instagram until someone opens a post.
 *
 * A Cron Trigger (see wrangler.jsonc) refreshes the feed every hour and renews the access
 * token every week. Instagram tokens expire after 60 days unless they are refreshed.
 *
 * Configuration:
 *   INSTAGRAM_ACCESS_TOKEN  secret, long lived token generated in the Meta app dashboard
 *   INSTAGRAM_KV            KV namespace holding the cached feed and the refreshed token
 *
 * Until both exist the API answers with an empty list and the section stays hidden.
 */

const API_BASE = 'https://graph.instagram.com/v27.0';
const TOKEN_REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';
const PROFILE_URL = 'https://www.instagram.com/thesocialclubkids/';

const FIELDS = 'id,caption,alt_text,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}';
// Used when the API rejects a field in the list above (field support differs between API versions).
const BASIC_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';

const FETCH_LIMIT = 12; // Ask for a few extra, since posts without a usable image are skipped.
const MAX_POSTS = 8;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const FEED_KEY = 'feed';
const TOKEN_KEY = 'token';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FEED_FRESH_MS = 2 * HOUR; // The cron refreshes hourly; past this, a page view refreshes it too.
const FEED_MAX_AGE_MS = 2 * DAY; // Older than this, image links have likely expired: show nothing.
const FEED_RETRY_MS = 15 * 60 * 1000; // After a failed refresh, page views wait this long before trying again.
const TOKEN_REFRESH_MS = 7 * DAY;
const TOKEN_RETRY_MS = DAY;

// Image links returned by the API live on Meta's CDN. Nothing else is ever fetched.
const MEDIA_HOST_SUFFIXES = ['.cdninstagram.com', '.fbcdn.net'];
const MEDIA_TYPES = /^image\/(jpeg|png|webp|avif|heic|heif)\b/i;
const MEDIA_PATH = /^\/api\/instagram\/media\/(\d{5,32})$/;

/* Routing */

export async function handleInstagram(request, env, ctx, url) {
  if (request.method !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
  }
  if (url.pathname === '/api/instagram') return handleFeed(env, ctx);
  const media = MEDIA_PATH.exec(url.pathname);
  if (media) return handleMedia(env, ctx, url, media[1]);
  return json(404, { ok: false, error: 'Not found.' });
}

/** Cron Trigger entry point: keep the token alive, then refresh the feed. */
export async function runInstagramCron(env) {
  if (!configured(env)) return;
  try {
    await renewToken(env);
  } catch (err) {
    console.error('instagram token renewal failed', message(err));
  }
  await refreshOrMark(env, await readFeed(env));
}

/* Feed */

async function handleFeed(env, ctx) {
  const feed = await currentFeed(env, ctx);
  const posts = (feed ? feed.posts : []).map((p) => ({
    id: p.id,
    type: p.type,
    href: p.permalink,
    alt: p.alt,
    src: `/api/instagram/media/${p.id}`,
  }));
  // An empty answer is cached only briefly, so the section shows up soon after the token is added.
  return json(200, { ok: true, posts }, { 'Cache-Control': `public, max-age=${posts.length ? 300 : 60}` });
}

/** The stored feed, refreshed first when it is missing or the cron has fallen behind. */
async function currentFeed(env, ctx) {
  if (!configured(env)) return null;
  const stored = await readFeed(env);
  const now = Date.now();
  const age = stored ? now - stored.fetchedAt : Infinity;
  const sinceLastTry = stored ? now - Math.max(stored.fetchedAt, stored.checkedAt || 0) : Infinity;

  let feed = stored;
  if (age >= FEED_FRESH_MS && sinceLastTry >= FEED_RETRY_MS) {
    // Still usable: answer now and catch up in the background. Otherwise wait for the refresh.
    if (age < FEED_MAX_AGE_MS) ctx.waitUntil(refreshOrMark(env, stored));
    else feed = await refreshOrMark(env, stored);
  }
  return feed && now - feed.fetchedAt < FEED_MAX_AGE_MS ? feed : null;
}

/** Refresh the feed. On failure keep what we have and note the attempt, so page views back off. */
async function refreshOrMark(env, stored) {
  try {
    return await refreshFeed(env);
  } catch (err) {
    console.error('instagram feed refresh failed', message(err));
    const marked = { fetchedAt: stored ? stored.fetchedAt : 0, checkedAt: Date.now(), posts: stored ? stored.posts : [] };
    await env.INSTAGRAM_KV.put(FEED_KEY, JSON.stringify(marked)).catch(() => {});
    return marked;
  }
}

async function readFeed(env) {
  const feed = await env.INSTAGRAM_KV.get(FEED_KEY, 'json');
  return feed && Array.isArray(feed.posts) && typeof feed.fetchedAt === 'number' ? feed : null;
}

async function refreshFeed(env) {
  const { token } = await resolveToken(env);
  let data;
  try {
    data = await graph(`${API_BASE}/me/media`, { fields: FIELDS, limit: FETCH_LIMIT, access_token: token });
  } catch (err) {
    // Code 100 means a field or parameter was rejected; anything else (expired token, outage) is final.
    if (err.code !== 100) throw err;
    console.warn('instagram rejected the full field list, retrying with basic fields:', message(err));
    data = await graph(`${API_BASE}/me/media`, { fields: BASIC_FIELDS, limit: FETCH_LIMIT, access_token: token });
  }
  const posts = (Array.isArray(data.data) ? data.data : []).map(toPost).filter(Boolean).slice(0, MAX_POSTS);
  const feed = { fetchedAt: Date.now(), posts };
  await env.INSTAGRAM_KV.put(FEED_KEY, JSON.stringify(feed));
  return feed;
}

function toPost(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id || '');
  if (!/^\d{5,32}$/.test(id)) return null;

  const type = m.media_type === 'VIDEO' ? 'video' : m.media_type === 'CAROUSEL_ALBUM' ? 'album' : 'image';
  const first = m.children && Array.isArray(m.children.data) ? m.children.data[0] : null;
  const image = [
    type === 'video' ? m.thumbnail_url : null,
    first ? (first.media_type === 'VIDEO' ? first.thumbnail_url : first.media_url) : null,
    type === 'video' ? null : m.media_url,
  ].find(isMediaUrl);
  if (!image) {
    console.warn(`instagram post ${id} skipped: no image on an allowed host`);
    return null;
  }

  const time = new Date(m.timestamp || '');
  return {
    id,
    type,
    permalink: isInstagramUrl(m.permalink) ? m.permalink : PROFILE_URL,
    timestamp: Number.isNaN(time.getTime()) ? null : time.toISOString(),
    alt: describe(m, type, time),
    image,
  };
}

/** Alt text for a post: Instagram's own alt text, or the start of the caption, or the date. */
function describe(m, type, time) {
  const label = type === 'video' ? 'Instagram video' : 'Instagram post';
  const text = tidy(m.alt_text) || tidy(m.caption);
  if (text) return `${label}: ${text}`;
  if (Number.isNaN(time.getTime())) return label;
  const date = time.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric' });
  return `${label} from ${date}`;
}

/** One clean line: no hashtags, mentions, emoji or dashes (brand rule), at most 140 characters. */
function tidy(value) {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/(^|\s)[#@][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]/gu, '')
    .replace(/\s+[-\u2010-\u2015\u2212]+\s+/g, ', ')
    .replace(/[-\u2010-\u2015\u2212]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
  if (text.length > 140) {
    text = text.slice(0, 140);
    const cut = text.lastIndexOf(' ');
    text = `${(cut > 80 ? text.slice(0, cut) : text).replace(/[\s,;:.!?]+$/, '')}\u2026`;
  }
  return text;
}

/* Image proxy */

async function handleMedia(env, ctx, url, id) {
  // Keyed by path only, so query strings cannot be used to fill the cache with copies.
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const feed = configured(env) ? await readFeed(env) : null;
  const post = feed && feed.posts.find((p) => p.id === id);
  // Only images in the current feed are served. The address comes from our own stored copy
  // of Instagram's answer, never from the request.
  if (!post || !isMediaUrl(post.image)) return notFound();

  let upstream;
  try {
    upstream = await fetch(post.image, { redirect: 'manual', headers: { Accept: 'image/*' } });
  } catch (err) {
    console.error('instagram image fetch failed', id, message(err));
    return unavailable();
  }
  const type = upstream.headers.get('Content-Type') || '';
  const length = Number(upstream.headers.get('Content-Length') || 0);
  if (upstream.status !== 200 || !MEDIA_TYPES.test(type) || length > MAX_IMAGE_BYTES) {
    console.error('instagram image rejected', id, upstream.status, type.slice(0, 60), length);
    return unavailable();
  }

  const response = new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': type,
      // One day: a post deleted on Instagram drops out of the feed within the hour and its
      // image stops being served from cache within a day.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex',
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

function isMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return MEDIA_HOST_SUFFIXES.some((suffix) => u.hostname.endsWith(suffix));
}

function isInstagramUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'www.instagram.com';
  } catch {
    return false;
  }
}

/* Access token
   The secret is the seed. Once a week the cron exchanges the working token for a fresh one
   and keeps it in KV, tagged with a hash of the seed. Setting a new secret (a different
   hash) makes the stored token stale, so the new secret takes over without any cleanup. */

async function resolveToken(env) {
  const seed = await sha256(env.INSTAGRAM_ACCESS_TOKEN);
  const stored = await env.INSTAGRAM_KV.get(TOKEN_KEY, 'json');
  if (stored && stored.seed === seed && typeof stored.token === 'string' && stored.token) {
    return { token: stored.token, seed, stored };
  }
  return { token: env.INSTAGRAM_ACCESS_TOKEN, seed, stored: null };
}

async function renewToken(env) {
  const { token, seed, stored } = await resolveToken(env);
  const now = Date.now();
  if (stored && now < stored.nextRefreshAt) return;

  let record;
  try {
    const out = await graph(TOKEN_REFRESH_URL, { grant_type: 'ig_refresh_token', access_token: token });
    if (typeof out.access_token !== 'string' || !out.access_token) throw new Error('no token in the response');
    const lifetime = Number(out.expires_in) > 0 ? Number(out.expires_in) * 1000 : 60 * DAY;
    record = { token: out.access_token, seed, expiresAt: now + lifetime, nextRefreshAt: now + TOKEN_REFRESH_MS };
    console.log(`instagram token renewed, valid until ${new Date(record.expiresAt).toISOString()}`);
  } catch (err) {
    // A token younger than 24 hours cannot be refreshed yet. Keep using it and try again tomorrow.
    record = { token, seed, expiresAt: stored ? stored.expiresAt : null, nextRefreshAt: now + TOKEN_RETRY_MS };
    console.error('instagram token was not renewed, retrying in a day:', message(err));
  }
  await env.INSTAGRAM_KV.put(TOKEN_KEY, JSON.stringify(record));
}

/* Helpers */

function configured(env) {
  return Boolean(env.INSTAGRAM_ACCESS_TOKEN && env.INSTAGRAM_KV);
}

/** GET a Graph API endpoint. Errors carry Instagram's message and code, never the URL or token. */
async function graph(endpoint, params) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('network error reaching Instagram');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    const detail = (body && body.error) || {};
    const err = new Error(`${res.status} ${String(detail.message || 'unexpected response').slice(0, 300)}`);
    err.code = detail.code;
    throw err;
  }
  return body;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: plainHeaders('no-store') });
}

function unavailable() {
  return new Response('Image unavailable', { status: 502, headers: plainHeaders('no-store') });
}

function plainHeaders(cache) {
  return { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' };
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
