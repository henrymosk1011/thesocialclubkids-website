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
src/worker.js              Contact API (validation, honeypot, rate limit, Turnstile, Resend)
wrangler.jsonc             Worker config, vars, rate limiter
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

Protections built in: same origin check, 32 KB body limit, honeypot field, minimum fill time, 5 submissions per minute per IP (Workers Rate Limiting), strict server side validation, HTML escaping in the email, no auto reply (so the form cannot be abused to send mail to strangers).

**Optional Cloudflare Turnstile**: create a widget (Managed mode) for both hostnames, put the site key in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, and add `TURNSTILE_SECRET_KEY` as a secret. The form loads Turnstile automatically when a site key is configured, using the *interaction only* appearance.

### Analytics and Search Console

* **Search Console**: verify with a DNS TXT record in Cloudflare, then submit `https://www.thesocialclubkids.com/sitemap.xml`.
* **Google Analytics 4**: add the gtag snippet as an external file (inline scripts are blocked by the CSP) and extend the CSP in `public/_headers`:
  `script-src https://www.googletagmanager.com`, `connect-src https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com`, `img-src https://*.google-analytics.com https://*.googletagmanager.com`.
* **Cloudflare Web Analytics** (cookieless): add `https://static.cloudflareinsights.com` to `script-src` and `https://cloudflareinsights.com` to `connect-src`.

The Privacy Policy already covers analytics cookies, Cloudflare, Resend, Calendly and Turnstile.

## Editing notes

* **Brand rules**: no dashes, hyphens or em dashes anywhere in visible copy (alt text and meta tags included), no dot graphics or bullets, no lines on headings. Phone numbers are written `(626) 765 1724`; ranges are written `5 to 7`.
* After changing `main.css` or `main.js`, bump the `?v=` query on their `<link>` and `<script>` tags so browsers pick up the new file.
* The tiny inline script in each page `<head>` is allowed by a SHA 256 hash in the CSP (`public/_headers`). If you change it, recompute the hash:
  `printf '%s' '<script body>' | openssl dgst -sha256 -binary | openssl base64`
* Images: each photo ships as AVIF + WebP at several widths inside `<picture>` with `srcset`, explicit `width`/`height`, and lazy loading below the fold.
* The footer year updates automatically from the visitor's clock.

## Accessibility

Target: WCAG 2.2 AA. Skip link, landmarks, logical headings, visible focus, AA contrast on every color pair, labelled form fields with announced errors and an error summary, keyboard friendly menu (focus trap, Escape), accordion with `aria-expanded`, carousel buttons with labels, external links announced, `prefers-reduced-motion` turns off smooth scrolling and every scroll effect, forced colors support. Verified with axe-core (0 violations) and Lighthouse (Accessibility 100).

## SEO

Unique titles and descriptions, canonical URLs, Open Graph and Twitter cards with a 1200×630 share image, JSON-LD (`LocalBusiness`, `Person`, `WebSite`, `FAQPage`, `BreadcrumbList`), `robots.txt`, `sitemap.xml`, web app manifest and icons. Lighthouse SEO 100.

## Credits

* GSAP and ScrollTrigger: GreenSock standard license (free, including commercial use).
* Lenis: MIT license, darkroom.engineering.
* Montserrat: SIL Open Font License 1.1.
