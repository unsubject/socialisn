# studio.socialisn.com — deploy runbook

First-time deploy of `apps/socialisn-studio/` on Railway behind Cloudflare.
Follow this exact sequence — it replays the `hkcitizensmedia.com` fix from 2026-04-20.

## 1. Railway service

- Create a new Railway service pointed at this repo, root directory `apps/socialisn-studio/`.
- Environment variables:
  - **Core**
    - `DATABASE_URL` — existing Railway Postgres (same instance used by socialisn + frontierwatch2). **Required.**
    - `STUDIO_ADMIN_PASSWORD` — password you'll type into the OAuth login page. **Required** for the native Claude Desktop connector flow.
    - `STUDIO_BASE_URL` — public URL, e.g. `https://studio.socialisn.com`. **Required** whenever `STUDIO_ADMIN_PASSWORD` is set.
    - `STUDIO_BEARER_TOKEN` — optional legacy bearer for `curl` and scripted access. Remove once all clients are on OAuth.
  - **LLM / research** (used by `build_thesis_brief`)
    - `ANTHROPIC_API_KEY` — same key used by the n8n briefing pipeline.
    - `PERPLEXITY_API_KEY` — optional; enables fresh-web evidence in the thesis brief.
    - `STUDIO_SONNET_MODEL` — optional; defaults to `claude-sonnet-4-5`.
  - **Google Tasks** (used by `check_parking_lot` and `list_daily_candidates` parking_lot_match)
    - `STUDIO_GOOGLE_CLIENT_ID`, `STUDIO_GOOGLE_CLIENT_SECRET`, `STUDIO_GOOGLE_REFRESH_TOKEN` — see `docs/google-tasks-setup.md` for the one-time OAuth dance.
    - `STUDIO_GOOGLE_TASKS_LIST_NAME` — optional; defaults to `Subjects`.
    - `STUDIO_GOOGLE_TASKS_LIST_ID` — optional; skips name-to-ID lookup.
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
  - Never use "Flexible" — it causes an infinite 301 loop.
- Switch the `studio` DNS record to **Proxied (orange cloud)**.
- Verify: `curl -I https://studio.socialisn.com/healthz` → `HTTP/2 200` with `server: cloudflare`.
- Verify OAuth metadata: `curl https://studio.socialisn.com/.well-known/oauth-authorization-server` returns JSON with `issuer`, `authorization_endpoint`, etc.

## 4. Connect Claude Desktop (native connector flow)

Canonical path — per-conversation toggleable connector, no `claude_desktop_config.json` entries.

1. **Claude Desktop → Settings → Connectors → Add custom connector.**
2. Fill in:
   - **Name:** anything, e.g. `Socialisn Studio`
   - **Remote MCP server URL:** `https://studio.socialisn.com/mcp`
3. Click Add / Connect. Claude Desktop auto-discovers `/.well-known/oauth-authorization-server`, performs DCR at `/register`, opens browser to `/authorize`.
4. Login page: enter `STUDIO_ADMIN_PASSWORD`, submit.
5. Browser redirects back to Claude Desktop's callback URL.
6. In any chat, toggle `Socialisn Studio` on/off per conversation.

Access tokens: 1h. Refresh tokens: 30d. Claude Desktop refreshes silently until the refresh token expires, then re-prompts.

### Fallback: `mcp-remote` stdio proxy (legacy bearer)

Escape hatch if OAuth flow breaks for a specific client:

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

Globally present in every chat. Prefer the Settings UI flow.

## Troubleshooting

- `curl -I https://studio.socialisn.com/healthz` returns `HTTP/2 301` → Cloudflare SSL/TLS is Flexible. Change to Full (strict).
- Railway cert issuance stuck → Cloudflare proxy is ON during HTTP-01. Toggle proxy OFF, delete + re-add domain in Railway.
- Connector browser tab flashes and errors → `STUDIO_ADMIN_PASSWORD` or `STUDIO_BASE_URL` isn't set; OAuth routes return 404. Set both, redeploy.
- `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="…"` → token expired. From Claude Desktop, remove + re-add the connector.
- `build_thesis_brief` returns `ANTHROPIC_API_KEY is required` → set it in Railway Variables.
- `build_thesis_brief` returns `Perplexity 4xx…` in `perplexity_error` → key invalid or rate-limited. Tool still returns corpus-only brief.
- `check_parking_lot` returns `google_tasks_not_configured` → see `docs/google-tasks-setup.md`.
- `check_parking_lot` returns `google_tasks_api_error` with `invalid_grant` → refresh token revoked or expired (7-day limit on unverified OAuth apps). Re-run the auth script.
