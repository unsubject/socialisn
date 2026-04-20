# studio.socialisn.com — deploy runbook

First-time deploy of `apps/socialisn-studio/` on Railway behind Cloudflare.
Follow this exact sequence — it replays the `hkcitizensmedia.com` fix from 2026-04-20.

## 1. Railway service

- Create a new Railway service pointed at this repo, root directory `apps/socialisn-studio/`.
- Environment variables:
  - `DATABASE_URL` — existing Railway Postgres (same instance used by socialisn + frontierwatch2). **Required.**
  - `STUDIO_BEARER_TOKEN` — fresh random token. MCP clients send this as `Authorization: Bearer <token>`. **Required.**
  - `ANTHROPIC_API_KEY` — same key used by the n8n briefing pipeline. **Required** for `build_thesis_brief` (and any later LLM-driven tool). Other tools work without it.
  - `PERPLEXITY_API_KEY` — optional. When set, `build_thesis_brief` augments corpus evidence with fresh-web research via the `sonar` model. Without it, the tool runs on corpus-only evidence.
  - `STUDIO_SONNET_MODEL` — optional; overrides the default Sonnet model (`claude-sonnet-4-5`, matching what the n8n pipeline runs). Useful for trying newer models (e.g. `claude-sonnet-4-6`) without a code change.
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

Claude Desktop's direct-HTTP remote MCP flow fails silently for bearer-authed servers. Use the `mcp-remote` stdio proxy pattern in `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Fully quit Claude Desktop (⌘Q) and reopen. First launch is slow (≈10–20 seconds) while `npx -y` fetches `mcp-remote`. In a new chat, type `/` — `socialisn-studio` should list its tools. Log file for debugging: `~/Library/Logs/Claude/mcp-server-socialisn-studio.log`.

## Troubleshooting

- `curl -I https://studio.socialisn.com/healthz` returns `HTTP/2 301` pointing back at the same URL → Cloudflare SSL/TLS is set to Flexible. Change to Full (strict).
- Railway cert issuance stuck → Cloudflare proxy is ON during HTTP-01 challenge. Toggle proxy OFF, delete and re-add the domain in Railway.
- `401 unauthorized` on `/mcp` → client is missing the `Authorization: Bearer …` header or the token doesn't match the service env var.
- `build_thesis_brief` returns `ANTHROPIC_API_KEY is required` → add the env var in Railway Variables, redeploy. (Other tools don't need it.)
- `build_thesis_brief` returns `Perplexity 4xx…` in `perplexity_error` → key is invalid or rate-limited. The tool still returns a corpus-only brief when Perplexity fails.
- Sonnet call times out (>90s) → shorten `corpus_limit` in the call (default 12) or check Anthropic API status.
