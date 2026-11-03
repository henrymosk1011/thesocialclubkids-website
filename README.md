# The Social Club website

Marketing site for **The Social Club** (thesocialclubkids.com), PEERS® social skills groups in La Cañada Flintridge, a part of The HummingBird Nest.

Designed by [TENELEVENMEDIA](https://www.tenelevenmedia.com).

## Stack

| Layer | Choice |
| --- | --- |
| Pages | Hand written static HTML, CSS and JavaScript in `public/` (no build step) |
| Motion | GSAP 3.15 + ScrollTrigger and Lenis 1.3 (vendored in `public/assets/js/vendor/`) |
| Fonts | Montserrat (variable, Latin subset), self hosted (no Google Fonts requests) |
| Hosting | Cloudflare Workers with Static Assets, deployed from GitHub by Workers Builds |
| Contact form | `src/worker.js` handles `POST /api/contact` and sends mail through Resend |
| Instagram feed | `src/worker.js` serves `GET /api/instagram` and proxies the images; token and feed cache live in Workers KV |

Only `/api/*` runs Worker code (`run_worker_first`), so every page and file is served straight from Cloudflare's edge cache.

```
public/
  index.html               One page site
  privacy/index.html       Privacy Policy
  accessibility/index.html Accessibility statement
  thanks/index.html        No JavaScript form fallback
  404.html
  _headers                 Security headers, CSP, caching
  _redirects
  robots.txt, sitemap.xml, site.webmanifest, og-image.jpg, icons
  assets/css/main.css
  assets/js/main.js        Interactions + motion
  assets/js/vendor/        gsap, ScrollTrigger, lenis
  assets/fonts/            woff2
  assets/img/              AVIF + WebP responsive images, logo SVGs
src/worker.js              Contact API (validation, honeypot, rate limit, Turnstile, Resend),
                           Instagram feed + image proxy, weekly token refresh (cron)
wrangler.jsonc             Worker config, vars, rate limiter, KV binding, cron
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # add a Resend key only if you want to send real mail locally
npm run dev                      # http://localhost:8787
```

`npm run check` runs a dry run deploy to validate the config.

## Deploying

Pushing to the production branch triggers **Cloudflare Workers Builds** (`npx wrangler deploy`). The Worker is named `thesocialclubkids`.

### Domain: GoDaddy to Cloudflare

1. In Cloudflare, the zone `thesocialclubkids.com` is added. Open **DNS > Records** and confirm the existing records were imported, especially the **MX and TXT records for email** (`contact@thesocialclubkids.com`). Mail records must stay **DNS only** (grey cloud).
2. In GoDaddy: **My Products > thesocialclubkids.com > DNS > Nameservers > Change > I'll use my own nameservers**, then enter the two Cloudflare nameservers shown on the zone overview. If DNSSEC is on at GoDaddy, turn it off first and re enable it in Cloudflare after the zone is active.
3. When the zone shows **Active**, open **Workers & Pages > thesocialclubkids > Settings > Domains & Routes** and add custom domains `www.thesocialclubkids.com` and `thesocialclubkids.com`. Cloudflare issues certificates automatically.
4. Make `www` canonical: **Rules > Redirect Rules > Create rule from template > Redirect from root to WWW** (301, keep query string).
5. **SSL/TLS > Edge Certificates**: turn on Always Use HTTPS. Leave Rocket Loader off (it conflicts with the Content Security Policy).

### Contact form (Resend)

The form works as soon as these are in place:

1. **Resend > Domains > Add domain**: `forms.thesocialclubkids.com` (region us-east-1). Add the records Resend lists (MX, SPF TXT, DKIM) to Cloudflare DNS as **DNS only**, then click Verify.
2. **Resend > API Keys > Create**: permission *Sending access*, restricted to that domain.
3. **Cloudflare > Workers & Pages > thesocialclubkids > Settings > Variables and Secrets > Add**: type *Secret*, name `RESEND_API_KEY`, paste the key. (Or `npx wrangler secret put RESEND_API_KEY`.)
4. `CONTACT_FROM` and `CONTACT_TO` live in `wrangler.jsonc`. If you verify a different sending domain, update `CONTACT_FROM` to match.

Until the key exists the API answers `503` and the form shows a friendly message with the phone number and email address.

**Fields and HIPAA.** The form collects only name, email, phone (optional) and program of interest. There is deliberately no message box and no child's age field: Resend states it is not HIPAA compliant and will not sign a Business Associate Agreement, and Cloudflare only signs BAAs on Enterprise plans, so this pipeline must not invite health details. The Worker also ignores any extra fields that arrive (for example from an old cached copy of the page) and never emails them. To collect intake details online, use a form from a vendor that signs a BAA (for example the client portal's own intake or contact widget) rather than this form.

Protections built in: same origin check, 32 KB body limit, honeypot field, minimum fill time, 5 submissions per minute per IP (Workers Rate Limiting), strict server side validation, HTML escaping in the email, no auto reply (so the form cannot be abused to send mail to strangers).

**Optional Cloudflare Turnstile**: create a widget (Managed mode) for both hostnames, put the site key in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, and add `TURNSTILE_SECRET_KEY` as a secret. The form loads Turnstile automatically when a site key is configured, using the *interaction only* appearance.

### Instagram feed

The "Moments from the club" strip shows the latest posts from [@thesocialclubkids](https://www.instagram.com/thesocialclubkids/). Until a token is set, it shows the built in club photos (each links to the Instagram profile), so the section never looks empty.

How it works: the Worker calls the Instagram API with Instagram Login (`graph.instagram.com/me/media`), caches the result in KV for an hour (serving the stale copy while it refreshes, and for up to a day if Instagram is down), and serves each image through `/api/instagram/media/<id>`. Visitors' browsers never contact Instagram, so the Content Security Policy stays `'self'` and the Privacy Policy did not need a new third party. A weekly cron refreshes the token, which otherwise expires after 60 days.

One time setup:

1. In the Instagram app, make @thesocialclubkids a professional account (Settings > Account type and tools > Switch to professional account). Business or Creator both work.
2. At [developers.facebook.com](https://developers.facebook.com/apps/), create an app and add the **Instagram** product, choosing **API setup with Instagram login**. It only needs the `instagram_business_basic` permission and can stay in development mode, because it only reads its own account.
3. Under **Generate access tokens**, add the @thesocialclubkids account, sign in as it, and copy the token (it is long lived).
4. Cloudflare > Workers & Pages > thesocialclubkids > Settings > Variables and Secrets > Add: type *Secret*, name `INSTAGRAM_TOKEN`, paste the token. (Or `npx wrangler secret put INSTAGRAM_TOKEN`.)
5. Check `https://www.thesocialclubkids.com/api/instagram`: it should return `"ok": true` with posts.

The `INSTAGRAM` KV namespace has no id in `wrangler.jsonc` on purpose: Wrangler and Workers Builds create it on the first deploy. If the token is ever revoked (for example after an Instagram password change), generate a new one and replace the secret; the Worker notices the new secret and uses it instead of the stored copy.

### Analytics and Search Console

* **Search Console**: verify with a DNS TXT record in Cloudflare, then submit `https://www.thesocialclubkids.com/sitemap.xml`.
* **Google Analytics 4**: add the gtag snippet as an external file (inline scripts are blocked by the CSP) and extend the CSP in `public/_headers`:
  `script-src https://www.googletagmanager.com`, `connect-src https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com`, `img-src https://*.google-analytics.com https://*.googletagmanager.com`.
* **Cloudflare Web Analytics** (cookieless): add `https://static.cloudflareinsights.com` to `script-src` and `https://cloudflareinsights.com` to `connect-src`.

The Privacy Policy already covers analytics cookies, Cloudflare, Resend, Calendly and Turnstile.

## Editing notes

* **Copy source**: visible copy matches the client's original site (thesocialclubkids.com on Webflow) word for word, including its hyphenation (`PEERS®-Based`, `5-7 years old`, `year-round`), the phone format `(626) 765-1724`, the address `808 Foothill Blvd. Unit A` and the email display `Contact@TheSocialClubKids.com`. Keep new copy consistent with it. Still avoid em dashes, dot graphics, bullets and lines on headings.
* The hero photo cards (`.persons`) are a rebuild of the original site's hover cards: 0.5s `ease`, 58% / 21% / 21% widths (`flex-grow: 2.76` vs `1`), the open photo zoomed to 115%. Hover opens a card with a mouse, tap opens it on touch, and below 700px the cards become a swipeable row.
* After changing `main.css` or `main.js`, bump the `?v=` query on their `<link>` and `<script>` tags so browsers pick up the new file.
* The tiny inline script in each page `<head>` is allowed by a SHA 256 hash in the CSP (`public/_headers`). If you change it, recompute the hash:
  `printf '%s' '<script body>' | openssl dgst -sha256 -binary | openssl base64`
* Images: each photo ships as AVIF + WebP at several widths inside `<picture>` with `srcset`, explicit `width`/`height`, and lazy loading below the fold.
* The footer year updates automatically from the visitor's clock.

## Accessibility

Target: WCAG 2.2 AA. Skip link, landmarks, logical headings, visible focus, AA contrast on every color pair, labelled form fields with announced errors and an error summary, keyboard friendly menu (focus trap, Escape), accordion with `aria-expanded`, carousel buttons with labels, external links announced, `prefers-reduced-motion` turns off smooth scrolling and every scroll effect, forced colors support. Verified with axe-core (0 violations) and Lighthouse (Accessibility 100).

WAVE (WebAIM) notes, so its AIM score stays at 10:

* Text over a photo needs a solid `background-color` behind it (the hero cards use `--ink`). WAVE ignores images and measures against that color, and it keeps the text readable if a photo fails to load.
* Don't put several links to the same URL next to each other. The fallback Instagram photos are plain images; the Follow button is the one link to the profile (live feed posts each link to their own post).
* Big decorative numbers that are `aria-hidden` are `<div>`s, not `<p>`s, so WAVE doesn't read them as possible headings. The footer tagline is a `<div>` for the same reason: it's a tagline, not a heading.
* Keep paragraph and label text at 15px (`.9375rem`) or larger. The WAVE browser extension flagged 13px and 14px `<p>`/`<span>` labels as "Very small text"; 15px passes.
* Test with the WAVE browser extension. WAVE's online checker (wave.webaim.org/report) does not apply this site's CSS, so it misses CSS based issues such as contrast and text size.

## SEO

Unique titles and descriptions, canonical URLs, Open Graph and Twitter cards with a 1200×630 share image (`og-image.jpg`, "Play. Connect. Grow."), JSON-LD (`LocalBusiness` with address, audience ages 5 to 18 and an `OfferCatalog` of every program, `WebSite`, `WebPage`, `FAQPage` matching the visible FAQ word for word, `BreadcrumbList` on legal pages), `robots.txt`, `sitemap.xml`, web app manifest and icons. One `h1`, one `h2` per section, descriptive alt text on every image, the hero photo preloaded with `fetchpriority="high"`. Lighthouse SEO, Accessibility and Best Practices 100 on mobile and desktop.

After the domain moves to this site, verify the domain in Google Search Console, submit the sitemap, and request indexing of the home page. Note that the old Webflow site is currently served with `noindex, nofollow`, so search engines have not been indexing it. Also make sure the Google Business Profile uses the same name, address and phone (`(626) 765-1724`) as the site.

## Credits

* GSAP and ScrollTrigger: GreenSock standard license (free, including commercial use).
* Lenis: MIT license, darkroom.engineering.
* Montserrat: SIL Open Font License 1.1.
