# Handoff — socialisn

_Last updated: 2026-04-19 (continuation)_

## FIRST THING NEXT SESSION MUST DO

**Connect to the user's n8n instance via MCP. Do not start editing n8n workflows until this is done. Do not ask the user to copy-paste JSON into the n8n UI — that's what the MCP is for.**

The user has n8n's native **Instance-level MCP** enabled at:

- n8n URL: `https://n8n.srv1565522.hstgr.cloud`
- MCP settings page: `Settings → MCP` (screenshot confirms "Enabled")
- Connection URL + API key: click **Connection details** on that page

### Verifying MCP is live

At session start, call `ToolSearch` with query `mcp__n8n`. If no tools come back, the MCP is **not** registered for this session — do not proceed with n8n changes. Print the config stanza below and ask the user to restart Claude Code.

### Config stanza — already committed

`.mcp.json` at the repo root is wired to env-var interpolation:

```jsonc
{
  "mcpServers": {
    "n8n": {
      "type": "http",
      "url": "${N8N_MCP_URL}",
      "headers": { "Authorization": "Bearer ${N8N_MCP_TOKEN}" }
    }
  }
}
```

Both values come from n8n Settings → MCP → Connection details → **Access Token** tab.

**Claude Code on the web (how this repo is being used):** add `N8N_MCP_URL` and `N8N_MCP_TOKEN` as repository env vars/secrets in the Claude Code web settings for `unsubject/socialisn`. The runner's session env is where `.mcp.json` picks them up. After adding, start a fresh session — MCP servers register at session start only.

**Claude Code locally:**

```bash
export N8N_MCP_URL="https://n8n.srv1565522.hstgr.cloud/mcp/<connection-path-from-UI>"
export N8N_MCP_TOKEN="<personal MCP Access Token>"
```

The `N8N_MCP_TOKEN` is the **MCP Access Token** shown in the Connection details popup — it's a separate credential from the regular n8n REST API key (`N8N_API_KEY`) used by the fallback deploy script. For the fallback script also set `N8N_BASE_URL=https://n8n.srv1565522.hstgr.cloud` and `N8N_API_KEY=<n8n personal API key>`.

### Fallback when MCP isn't available

`scripts/deploy_n8n_workflows.sh` does plain REST upserts using `$N8N_BASE_URL` + `$N8N_API_KEY`. Use only if the MCP route is down — MCP is still the default.

### Reconcile direction

**Git is the source of truth.** If a workflow exists in n8n but not in git, export it and commit. If it exists in git but not in n8n, upsert it via MCP (`create_workflow_from_code` / `update_workflow`) or the fallback script.

## Today's delivery (2026-04-19)

### Subscription-email pipeline — code merged to `main`, NOT deployed

Three PRs merged:
- **#30** — Initial `fetch-gmail-subscriptions.json`: hourly schedule → Gmail `label:Subscription` → normalize → Postgres → trash
- **#31** — Inserted Claude Haiku 4.5 enrichment between normalize and save; strips ads/fluff/footers, returns `{summary, themes, key_facts}` JSON, rendered to markdown and stored in new `newsletter_items.summary` column
- **#32** — Added `.github/workflows/deploy_n8n.yml` to auto-deploy n8n workflows on push to `main`. **This turned out to be the wrong architecture** (see next section).

### What's actually running in n8n right now (per user screenshots)

- MCP-exposed workflows on the instance: Generate Daily Briefing, Fetch News (RSS), Fetch Podcasts, Process Items with Haiku, Fetch Perplexity Search, Fetch YouTube Videos.
- **`Fetch Gmail Subscriptions` (today's new workflow) is NOT yet in n8n.** It exists only as JSON at `n8n/workflows/fetch-gmail-subscriptions.json` on `main`.
- The canvas also shows an older workflow `Fetch Newsletter Emails1` (note the `1` suffix — a duplicate import of `fetch-gmail-newsletters.json`) with a manually added `Delete a message` node that is **erroring** (red frame, ✕ icon). Likely cause: the Gmail OAuth2 credential is missing the `https://www.googleapis.com/auth/gmail.modify` scope required for `messages.trash`, or the `messageId` expression doesn't resolve at that point in the flow. Next session should diagnose via MCP (`execute_workflow` with a test payload, inspect the error).

### Known broken path — GitHub Actions deploy has been deleted

PR #32's `.github/workflows/deploy_n8n.yml` was removed this session. It failed with:

```
curl: (28) Failed to connect to n8n.srv1565522.hstgr.cloud port 443 after 133318 ms
```

GitHub-hosted runners are blocked at layer 4 by Hostinger's edge (server itself responds `403` from other networks — it's reachable, just not from GitHub runners). Rejected alternatives: whitelisting GitHub's `/meta` IP ranges (brittle), self-hosted runner (ops overhead), SSH-based deploy (reinvents MCP).

Replacement: `scripts/deploy_n8n_workflows.sh` runs locally from a shell that can reach the n8n host. Preferred path remains n8n MCP from Claude Code.

## Outstanding work next session should pick up

1. ~~**Wire up n8n MCP**~~ — `.mcp.json` committed on branch `claude/wire-n8n-mcp-server-Ggb8R` (2026-04-19). Next session: export `N8N_MCP_URL` + `N8N_MCP_TOKEN`, then verify with `ToolSearch` query `mcp__n8n`.
2. **Deploy `fetch-gmail-subscriptions.json`** via MCP `create_workflow_from_code` (or `update_workflow` if user imported manually). Validate with `validate_workflow` first.
3. **Apply the DB migration** — `ALTER TABLE newsletter_items ADD COLUMN IF NOT EXISTS summary TEXT;` — either via n8n's Postgres credential inside a throwaway workflow, or a one-off psql. Already in `infra/init.sql` for fresh DBs.
4. **Bind credentials** on the newly imported workflow (one-time, via UI — credentials don't live in git):
   - `Gmail OAuth2` — must have `gmail.modify` scope so the trash step works
   - `Postgres`
   - `Anthropic API Key` (HTTP Header Auth, header `x-api-key`)
5. **Diagnose the `Delete a message` error** on the older `Fetch Newsletter Emails1` canvas. Either fix it or delete that workflow after confirming `fetch-gmail-subscriptions` subsumes it.
6. ~~Delete `.github/workflows/deploy_n8n.yml`~~ — done this session.
7. **Activate** `Fetch Gmail Subscriptions` (`active: true`) once verified.

## Architecture

```
Hostinger VPS (n8n.srv1565522.hstgr.cloud):
  ├─ n8n (self-hosted) — MCP-enabled, API-enabled
  └─ Postgres           — n8n DB + app DB in one instance

GitHub (unsubject/socialisn):
  └─ Source of truth for:
     - n8n/workflows/*.json
     - infra/init.sql
     - config/*.yaml
     - scripts/*.py (legacy, being migrated to n8n)

Claude Code session:
  ├─ GitHub MCP (scoped to unsubject/socialisn)
  └─ n8n MCP (MUST BE CONFIGURED — see top)
```

## Database schema (app tables)

Defined in `infra/init.sql`. Key tables:

- `sources` — runtime config for fetchers (seeded by `infra/seed_sources.sql`)
- `youtube_items`, `news_items`, `podcast_items` — raw fetched items
- `newsletter_items` — raw subscription emails; as of today has a `summary TEXT` column holding the Haiku-generated markdown summary
- `item_enrichment(item_type, item_id, summary_zh, keywords_zh[], processed_at)` — 1:1 enrichment for youtube/news/podcast (newsletter currently uses the inline `newsletter_items.summary` column instead; revisit if consolidation is desired)
- `briefings(date, slot, markdown, html, email_sent_at, ...)`

## n8n credentials in use (per previous sessions)

- `Postgres`
- `Anthropic API Key` (HTTP Header Auth, `x-api-key`)
- `Gmail OAuth2` — verify `gmail.modify` scope before activating trash-based workflows
- `YouTube API Key` (`httpQueryAuth`, Name=`key`)
- `Perplexity API` (Bearer)

## n8n SDK gotchas (from 2026-04-18 session — still valid)

- `output: [{...}]` in `@n8n/workflow-sdk` node definitions is **sample data for the editor only**, not runtime pinned data.
- `runOnceForEachItem` Code nodes return a single `{json: {...}}`; `runOnceForAllItems` uses `$input.all()` / `$("NodeName").all()` with `pairedItem: { item: k }` for lineage.
- `executeWorkflow` node's `workflowId` needs resource locator format: `{ __rl: true, value: 'ID', mode: 'id' }`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` when downstream filters use `fetched_at >= NOW() - INTERVAL 'X hours'` — `DO NOTHING` strands items outside the window.
- Always call `validate_workflow` before `update_workflow` / `create_workflow_from_code`.

## Open questions for the user

1. Confirm `Gmail OAuth2` credential scope — does it include `https://www.googleapis.com/auth/gmail.modify`? If not, re-authorize; trash steps will 403 without it.
2. Is the older `Fetch Newsletter Emails1` workflow still needed, or should it be deleted in favor of `Fetch Gmail Subscriptions`?
3. Frontierwatch and newsletter-digest sibling repos still pending migration (carried over from yesterday's handoff).

## Working branch

Today's branch (merged, can be deleted): `claude/n8n-gmail-subscription-workflow-AFmoj`.
Next session: use whatever branch the user specifies at startup, or create a fresh `claude/<topic>-<hash>` per task.

## Don't do this again

- Don't write a GitHub Actions workflow to deploy to a private n8n instance behind a network firewall. Use the n8n MCP instead.
- Don't ask the user to copy-paste JSON through the n8n UI. Use `create_workflow_from_code` / `update_workflow` via MCP.
- Don't assume capabilities from prior sessions carry over. MCP servers are per-session config. Check what tools are loaded at session start before planning the work.
