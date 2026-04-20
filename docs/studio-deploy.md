# studio.socialisn.com — deploy runbook

First-time deploy of `apps/socialisn-studio/` on Railway behind Cloudflare.
Follow this exact sequence — it replays the `hkcitizensmedia.com` fix from 2026-04-20.

## 1. Railway service

- Create a new Railway service pointed at this repo, root directory `apps/socialisn-studio/`.
- Environment variables:
  - `DATABASE_URL` — existing Railway Postgres (same instance used by socialisn + frontierwatch2). **Required.**
  - `STUDIO_ADMIN_PASSWORD` — password you'll type into the OAuth login page. **Required** for the native Claude Desktop connector flow.
  - `STUDIO_BASE_URL` — public URL, e.g. `https://studio.socialisn.com`. **Required** whenever `STUDIO_ADMIN_PASSWORD` is set. Used in OAuth metadata (issuer, authorization_endpoint, …).
  - `STUDIO_BEARER_TOKEN` — optional legacy bearer for `curl` and scripted access. Keep it during migration; remove once all clients are on OAuth.
  - `ANTHROPIC_API_KEY` — same key used by the n8n briefing pipeline. **Required** for `build_thesis_brief`. Other tools work without it.
  - `PERPLEXITY_API_KEY` — optional. When set, `build_thesis_brief` augments corpus evidence with fresh-web research.
  - `STUDIO_SONNET_MODEL` — optional; defaults to `claude-sonnet-4-5`. Set to `claude-sonnet-4-6` to try the newer model without a code change.
- At least one of `STUDIO_BEARER_TOKEN` or `STUDIO_ADMIN_PASSWORD` must be set; the service refuses to start otherwise.
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
- Verify OAuth metadata is reachable: `curl https://studio.socialisn.com/.well-known/oauth-authorization-server` returns JSON with `issuer`, `authorization_endpoint`, etc.

## 4. Connect Claude Desktop (native connector flow)

This is the canonical path — a per-conversation toggleable connector, no entries in `claude_desktop_config.json`.

1. **Claude Desktop → Settings → Connectors → Add custom connector.**
2. Fill in:
   - **Name:** anything, e.g. `Socialisn Studio`
   - **Remote MCP server URL:** `https://studio.socialisn.com/mcp`
3. Click Add / Connect. Claude Desktop auto-discovers `/.well-known/oauth-authorization-server`, performs Dynamic Client Registration at `/register`, then opens your default browser to `/authorize`.
4. Browser shows a minimal password-protected login page ("Authorize Claude Desktop to access socialisn-studio"). Type `STUDIO_ADMIN_PASSWORD`, submit.
5. Browser redirects back to Claude Desktop's callback URL; tab closes itself or shows a success message.
6. In any chat, open the tools picker and toggle `Socialisn Studio` on/off per conversation. The four tools appear only when enabled in that chat.

Access tokens are 1-hour; refresh tokens 30 days. Claude Desktop handles refresh silently. If the refresh token expires, Claude Desktop re-prompts for the password.

### Fallback: `mcp-remote` stdio proxy (legacy bearer)

If the OAuth flow doesn't work for a specific client and you need a quick path to tools, you can fall back to the bearer-based `mcp-remote` shim in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "socialisn-studio": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://studio.socialisn.com/mcp",
        "--header",
        "Authorization: Bearer <STUDIO_BEARER_TOKEN>"
      ]
    }
  }
}
```

This makes the tools globally present in every Claude Desktop chat — acceptable as an escape hatch, but the Settings UI flow above is the preferred path.

## Troubleshooting

- `curl -I https://studio.socialisn.com/healthz` returns `HTTP/2 301` pointing back at the same URL → Cloudflare SSL/TLS is set to Flexible. Change to Full (strict).
- Railway cert issuance stuck → Cloudflare proxy is ON during HTTP-01 challenge. Toggle proxy OFF, delete and re-add the domain in Railway.
- Claude Desktop "Add custom connector" browser tab flashes and errors → `STUDIO_ADMIN_PASSWORD` or `STUDIO_BASE_URL` isn't set, so `/.well-known/oauth-authorization-server` returns 404. Set both env vars and redeploy.
- Login page says "Wrong password" → it really does mean wrong password. Check Railway Variables.
- `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="…"` → the token expired or was never issued. From Claude Desktop, remove the connector and re-add. From `curl`, re-use the `STUDIO_BEARER_TOKEN`.
- `build_thesis_brief` returns `ANTHROPIC_API_KEY is required` → add the env var in Railway Variables, redeploy.
- `build_thesis_brief` returns `Perplexity 4xx…` in `perplexity_error` → key is invalid or rate-limited. The tool still returns a corpus-only brief when Perplexity fails.
- Sonnet call times out (>90s) → shorten `corpus_limit` in the call or check Anthropic API status.
