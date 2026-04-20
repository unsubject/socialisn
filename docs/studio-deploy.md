# studio.socialisn.com — deploy runbook

First-time deploy of `apps/socialisn-studio/` on Railway behind Cloudflare.
Follow this exact sequence — it replays the `hkcitizensmedia.com` fix from 2026-04-20.

## 1. Railway service

- Create a new Railway service pointed at this repo, root directory `apps/socialisn-studio/`.
- Environment variables:
  - `DATABASE_URL` → existing Railway Postgres (same instance used by socialisn + frontierwatch2).
  - `STUDIO_BEARER_TOKEN` → fresh random token. MCP clients will send this as `Authorization: Bearer <token>`.
- Expose the service publicly; Railway assigns a `*.up.railway.app` URL.
- Verify: `curl https://<railway-url>/healthz` → `ok`.

## 2. Cloudflare DNS — proxy OFF first

- In Cloudflare DNS for `socialisn.com`, add a `CNAME`:
  - Name: `studio`
  - Target: `<railway-url>` (no scheme)
  - Proxy status: **DNS only (grey cloud)**. Do not enable the orange-cloud proxy yet.
- In Railway → Settings → Domains, add `studio.socialisn.com`. Railway issues a Let's Encrypt cert via HTTP-01.
- Wait until Railway reports the cert as issued (a few minutes).

## 3. Flip on Cloudflare proxy with correct SSL mode

- In Cloudflare SSL/TLS → Overview, set mode to **Full (strict)**.
  - Never use "Flexible" — it causes an infinite 301 loop (Railway redirects HTTP→HTTPS, Cloudflare caches the redirect back at the browser). See `HANDOFF.md` § "Railway + Cloudflare gotcha".
- Switch the `studio` DNS record to **Proxied (orange cloud)**.
- Verify: `curl -I https://studio.socialisn.com/healthz` → `HTTP/2 200` with `server: cloudflare`.

## 4. MCP client wiring

- In the client (Claude desktop, ChatGPT, etc.), add a remote MCP server:
  - URL: `https://studio.socialisn.com/mcp`
  - Header: `Authorization: Bearer <STUDIO_BEARER_TOKEN>`
- First handshake should succeed; `tools/list` returns an empty array until phase 2.1 step 2 lands primitives.

## Troubleshooting

- `curl -I https://studio.socialisn.com/healthz` returns `HTTP/2 301` pointing back at the same URL → Cloudflare SSL/TLS is set to Flexible. Change to Full (strict).
- Railway cert issuance stuck → Cloudflare proxy is ON during HTTP-01 challenge. Toggle proxy OFF, delete and re-add the domain in Railway.
- `401 unauthorized` on `/mcp` → client is missing the `Authorization: Bearer …` header or the token doesn't match the service env var.
