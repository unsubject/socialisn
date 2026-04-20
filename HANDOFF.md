# Handoff — socialisn

_Last updated: 2026-04-20 (briefing v2 shipped; frontierwatch2 spun off 2026-04-19)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → Claude Haiku summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Briefing v2 — shipped 2026-04-20:**

- **Generate Briefing · Morning** (`9ZVO3YdIXpyVFKU2`) — `active: true`. 08:00 ET cron. Fetches last-24h newsletter/news/YouTube/podcast + frontier_briefings; Sonnet 4.5 synthesizes; frontier content appended verbatim; upserts `briefings (slot='morning')`. Source of truth: `n8n/workflows/generate-briefing-morning.ts`.
- **Generate Briefing · Update** (`GIncZJ8eJnXz1SzU`) — `active: true`. Consolidated midday+evening in one workflow with three triggers: 14:00 ET cron → `slot='midday'`, 20:00 ET cron → `slot='evening'`, Telegram message `Update` → slot picked by ET time-of-day (before 17:00 → midday, else evening). Scheduled paths skip-if-exists; Telegram path always regenerates and replies to chat. Source of truth: `n8n/workflows/generate-briefing-update.ts`.
- **Retired**: `Generate Daily Briefing` (`F0g69WDiNUX0OXNW`) archived. The separate `Generate Briefing · Midday` (`HBizcBtDaZZ3Lxxq`) and `Generate Briefing · Evening` (`lD00GXBo0c9OTuD5`) were also archived after consolidation.

**Briefings site** — `apps/briefings-web/` Hono + pg service on Railway, renders `briefings.html` directly from Postgres. Routes: `/`, `/b/:date/:slot`, `/archive`, `/feed.xml`, `/healthz`. Healthcheck confirmed up.

**Other fetch workflows** — verified active 2026-04-19:

- Fetch News (RSS) `W2QHzmBjyUFs0xsd`
- Fetch Podcasts `Ykpcl95qtvzMv70b`
- Fetch Perplexity Search `rkiWYmYBoVyi8Ih2`
- Fetch YouTube Videos `x5s2rk7HWNQjX5N1`
- Process Items with Haiku `OG4iOnuMwxoJDbvK`

Before editing any of them, run `get_workflow_details` and diff against `n8n/workflows/*.ts`. Git is source of truth.

## Briefing v2 — design vs. as-built

Full design in `docs/briefing-v2-design.md`. One deviation shipped: midday and evening are implemented as a **single `Generate Briefing · Update` workflow with three triggers** rather than two separate workflows. Driver: a Telegram bot can only target one webhook URL, so two workflows each with a Telegram Trigger was an anti-pattern. Consolidating lets one Telegram Trigger own the webhook and pick slot by ET time-of-day. The design doc's pipeline shape (cutoff → fetch delta → build prompt → Sonnet → combine → save) is unchanged.

The single magic word is `Update` (case-sensitive, plain message). Filtered via IF node right after the Telegram Trigger; any other text is silently ignored.

## FrontierWatch2 spin-off (2026-04-19)

Sibling private repo [`unsubject/frontierwatch2`](https://github.com/unsubject/frontierwatch2) replaced `unsubject/frontierwatch` (POC → production rewrite). Shares this repo's Railway Postgres and owns `frontier_watches`, `frontier_briefings`, `frontier_watchlist`. Six sector workflows live on the n8n instance (names prefixed `FrontierWatch2 · `):

- `computing-ai` active and validated end-to-end
- `economics`, `monetary-policy`, `biotech`, `energy`, `securities-futures` created but need HTTP credential binding + publish

All FrontierWatch work happens in that repo's HANDOFF.md. The briefing v2 pipeline reads `frontier_briefings` read-only; don't write to `frontier_*` from socialisn.

## n8n MCP is wired

`.mcp.json` + `N8N_MCP_URL` / `N8N_MCP_TOKEN` configured. At session start verify by calling `ToolSearch` with query `mcp__n8n`. If no tools load, env vars aren't injected — start a fresh session after adding them in Claude Code web settings.

## Credential names (actual, on instance)

- Postgres: **`Railway`** (not `Postgres`)
- Gmail OAuth2: **`Gmail account`** — has `gmail.modify` scope; trash step works
- `Anthropic API Key` (httpHeaderAuth, `x-api-key`) — used by socialisn and frontierwatch2
- `Perplexity API` (httpBearerAuth) — used by socialisn and frontierwatch2
- `YouTube API Key` (httpQueryAuth, Name=`key`) — socialisn only
- `Telegram account` (telegramApi) — used by the Update workflow's Trigger and Reply nodes. Auto-assigned by MCP when the node's credential type matches.

## n8n gotchas (stable invariants)

- **HTTP Request credentials aren't auto-assigned by MCP.** `newCredential('Name')` in SDK doesn't resolve for HTTP nodes. After `create_workflow_from_code` with HTTP nodes, bind each one in the n8n UI once. Bindings persist across future `update_workflow` calls. Symptom when unbound: `NodeOperationError: Credentials not found` on first manual execute.
- **Telegram bot = one webhook.** A bot can only point setWebhook at one URL. If two workflows each have a Telegram Trigger, whichever was saved last wins — the other silently stops receiving. Use a single workflow to own the bot and route internally (see briefing v2 as-built).
- `update_workflow` auto-assigns Postgres, Gmail, and telegramApi credentials when it recognizes the type. Existing HTTP auth bindings are preserved across updates.
- `output: [{...}]` in `@n8n/workflow-sdk` node definitions is editor sample data, not runtime pinned data.
- The SDK validator blocks post-fix methods (e.g. `.trim()`) on template-literal code strings. Define code strings plainly.
- `runOnceForEachItem` Code nodes return `{ json: {...} }`; `runOnceForAllItems` uses `$input.all()` / `$("NodeName").all()` with `pairedItem: { item: k }`.
- `executeWorkflow` node's `workflowId` needs resource locator format: `{ __rl: true, value: 'ID', mode: 'id' }`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` when downstream filters use `fetched_at >= NOW() - INTERVAL 'X hours'`.
- Gmail node with `simple: false` and no explicit `options.format: 'full'` returns `msg.from` as `{ text, html, value[] }` — NOT a string. `.match()` on it crashes. Use a defensive `pickHeader()` that handles multiple shapes (see `fetch-gmail-subscriptions.ts`).
- `scheduleTrigger` supports `timezone` for DST-aware cron (used throughout briefing v2: `America/New_York`).
- SDK `fan_in` pattern: multiple triggers feeding into a shared downstream node works by declaring the chain once then using `.add(secondTrigger).to(sharedNode)` — the second call adds an incoming edge without redefining the downstream.

## Outstanding work

1. `newsletter-digest` sibling repo still pending evaluation (carried over from earlier handoffs).
2. Dashboard (`docs/`) static Pages site — news/youtube/podcast/topics RSS feeds are still stale (no workflow writes to them). Briefing feeds moved to the Railway site under v2; these four remain a gap.

## Don't do this again

- Don't write a GitHub Actions workflow to deploy to this n8n instance — Hostinger blocks GitHub runners at L4. Use n8n MCP from Claude Code or the local `scripts/deploy_n8n_workflows.sh` fallback.
- Don't ask the user to copy-paste JSON through the n8n UI. Use `update_workflow` with SDK code, or `create_workflow_from_code`.
- Don't call `.trim()` (or other post-fix methods) on template-literal-defined code strings in SDK files — the validator will reject.
- Don't assume capabilities carry over. MCP servers register per-session; verify at session start.
- Don't touch the `frontier_*` tables from this repo (reads are fine; writes are not). They belong to `unsubject/frontierwatch2`.
- Don't put a Telegram Trigger on more than one workflow bound to the same bot — only one will survive.
- Don't send briefings by email. The Railway site + DB replace that path by design.
