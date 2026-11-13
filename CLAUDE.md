# Working agreement for Claude

## Ship every change live

The site owner asked (November 2, 2026) that every change they request goes live
automatically, without waiting for a separate go ahead. After making a requested change:

1. Check it locally: `npm run check` (dry run deploy), and view the affected pages at
   desktop and phone widths.
2. Commit to the working branch and push.
3. Open a pull request into `main` and merge it.
4. Merging to `main` triggers Cloudflare Workers Builds, which deploys the Worker
   `thesocialclubkids`. Confirm that build and deployment succeeded, then report the
   live URL.

Moving the domain (DNS or nameserver changes), deleting resources, or changing account
level settings in Cloudflare, GitHub, Resend or Instagram still needs the owner's
confirmation first.

## Project notes

See `README.md` for the stack, the contact form, the Instagram feed setup, and the
editing rules (copy matches the client's original site word for word).
