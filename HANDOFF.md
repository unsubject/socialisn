# Handoff — socialisn

_Last updated: 2026-04-19_

## FIRST THING NEXT SESSION MUST DO

**Connect to the user's n8n instance via MCP. Do not start editing n8n workflows until this is done. Do not ask the user to copy-paste JSON into the n8n UI — that's what the MCP is for.**

The user has n8n's native **Instance-level MCP** enabled at:

- n8n URL: `https://n8n.srv1565522.hstgr.cloud`
- MCP settings page: `Settings → MCP` (screenshot confirms "Enabled")
- Connection URL + API key: click **Connection details** on that page

Add it to Claude Code's MCP config (`~/.claude/settings.json` or the project `.mcp.json`) so the `mcp__n8n__*` tools load at session start. Ask the user for the connection URL + API key — do **not** hard-code; keep the key in an env var. Expected tool surface in previous sessions: `list_workflows`, `get_workflow`, `update_workflow`, `create_workflow_from_code`, `validate_workflow`, `execute_workflow`, etc.

Once connected, reconcile state: **git is the source of truth**. If a workflow exists in n8n but not in git, export it with `get_workflow` and commit. If it exists in git but not in n8n, upsert it via `create_workflow_from_code` / `update_workflow`.

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

### Known broken path — abandon the GitHub Actions deploy

PR #32's `.github/workflows/deploy_n8n.yml` fails with:

```
curl: (28) Failed to connect to n8n.srv1565522.hstgr.cloud port 443 after 133318 ms
```

GitHub-hosted runners are blocked at layer 4 by Hostinger's edge (server itself responds `403` from other networks — it's reachable, just not from GitHub runners). Attempted fixes considered and rejected: whitelist GitHub's `/meta` IP ranges (brittle), self-hosted runner (ops overhead), SSH-based deploy (OK but still reinvents what n8n MCP already does for free).

**Next session: delete `.github/workflows/deploy_n8n.yml`.** With n8n MCP wired in, Claude deploys workflows directly via MCP — no CI pipeline needed for n8n.

## Outstanding work next session should pick up

1. **Wire up n8n MCP** (see top of file).
2. **Deploy `fetch-gmail-subscriptions.json`** via MCP `create_workflow_from_code` (or `update_workflow` if user imported manually). Validate with `validate_workflow` first.
3. **Apply the DB migration** — `ALTER TABLE newsletter_items ADD COLUMN IF NOT EXISTS summary TEXT;` — either via n8n's Postgres credential inside a throwaway workflow, or a one-off psql. Already in `infra/init.sql` for fresh DBs.
4. **Bind credentials** on the newly imported workflow (one-time, via UI — credentials don't live in git):
   - `Gmail OAuth2` — must have `gmail.modify` scope so the trash step works
   - `Postgres`
   - `Anthropic API Key` (HTTP Header Auth, header `x-api-key`)
5. **Diagnose the `Delete a message` error** on the older `Fetch Newsletter Emails1` canvas. Either fix it or delete that workflow after confirming `fetch-gmail-subscriptions` subsumes it.
6. **Delete `.github/workflows/deploy_n8n.yml`** — abandoned approach.
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
