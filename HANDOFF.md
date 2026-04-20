# Handoff — socialisn

_Last updated: 2026-04-19 (briefing v2 design locked; frontierwatch2 spun off earlier today)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → Claude Haiku summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Generate Daily Briefing** (`F0g69WDiNUX0OXNW`) — `active: false`. Being retired by the v2 redesign; see `docs/briefing-v2-design.md`. Will be archived once v2 ships.

**Other fetch workflows** — all verified active on the instance 2026-04-19:

- Fetch News (RSS) `W2QHzmBjyUFs0xsd`
- Fetch Podcasts `Ykpcl95qtvzMv70b`
- Fetch Perplexity Search `rkiWYmYBoVyi8Ih2`
- Fetch YouTube Videos `x5s2rk7HWNQjX5N1`
- Process Items with Haiku `OG4iOnuMwxoJDbvK`

Before editing any of them, run `get_workflow_details` and diff against `n8n/workflows/*.ts`. Git is source of truth.

## Briefing v2 — design locked (2026-04-19)

Design interview complete. Full spec in `docs/briefing-v2-design.md`.

Shape: three ET slots — morning 08:00 cron, midday 14:00 cron + Telegram `/midday`, evening 20:00 cron + Telegram `/evening`. Delta logic keyed off the most-recent-prior-slot's `generated_at`. Sources add `newsletter_items` and `frontier_briefings` (curated by last-24h activity) on top of existing news/youtube/podcast. Output is Postgres `briefings` (DB is the canonical source of truth for a future content-creation agent) plus a Railway-hosted Hono site at `apps/briefings-web/`. Email is removed.

Implementation not yet started — proceed with phase 2 of the design doc (schema migration) next.

## FrontierWatch2 spin-off (2026-04-19)

A sibling private repo [`unsubject/frontierwatch2`](https://github.com/unsubject/frontierwatch2) was created to replace `unsubject/frontierwatch` (POC → production rewrite). It shares this repo's Railway Postgres and owns three new tables: `frontier_watches`, `frontier_briefings`, `frontier_watchlist`. Six sector workflows live on the n8n instance (names prefixed `FrontierWatch2 · `):

- `computing-ai` is active and validated end-to-end
- `economics`, `monetary-policy`, `biotech`, `energy`, `securities-futures` are created but need HTTP credential binding + publish

All further work on FrontierWatch happens in that repo's HANDOFF.md. The briefing v2 pipeline reads `frontier_briefings` read-only; don't write to `frontier_*` from this repo.

## n8n MCP is wired

`.mcp.json` + `N8N_MCP_URL` / `N8N_MCP_TOKEN` is configured. At session start verify by calling `ToolSearch` with query `mcp__n8n`. If no tools load, env vars aren't injected — start a fresh session after adding them in Claude Code web settings.

## Credential names (actual, on instance)

- Postgres: **`Railway`** (not `Postgres` — prior handoffs were wrong on this)
- Gmail OAuth2: **`Gmail account`** — confirmed has `gmail.modify` scope; trash step works
- `Anthropic API Key` (httpHeaderAuth, `x-api-key`) — used by both socialisn and frontierwatch2
- `Perplexity API` (httpBearerAuth) — used by both socialisn and frontierwatch2
- `YouTube API Key` (httpQueryAuth, Name=`key`) — socialisn only

## n8n gotchas (stable invariants)

- **HTTP Request credentials aren't auto-assigned by MCP.** `newCredential('Name')` in SDK doesn't resolve for HTTP nodes. After `create_workflow_from_code` with HTTP nodes, bind each one in the n8n UI once. Bindings persist across future `update_workflow` calls. Symptom when unbound: `NodeOperationError: Credentials not found` on first manual execute.
- `update_workflow` auto-assigns Postgres and Gmail credentials when it recognizes the type. Existing HTTP auth bindings are preserved across updates.
- `output: [{...}]` in `@n8n/workflow-sdk` node definitions is editor sample data, not runtime pinned data.
- The SDK validator blocks post-fix methods (e.g. `.trim()`) on template-literal code strings. Define code strings plainly.
- `runOnceForEachItem` Code nodes return `{ json: {...} }`; `runOnceForAllItems` uses `$input.all()` / `$("NodeName").all()` with `pairedItem: { item: k }`.
- `executeWorkflow` node's `workflowId` needs resource locator format: `{ __rl: true, value: 'ID', mode: 'id' }`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` when downstream filters use `fetched_at >= NOW() - INTERVAL 'X hours'`.
- Gmail node with `simple: false` and no explicit `options.format: 'full'` returns `msg.from` as `{ text, html, value[] }` — NOT a string. `.match()` on it crashes. Use a defensive `pickHeader()` that handles multiple shapes (see `fetch-gmail-subscriptions.ts`).
- `scheduleTrigger` supports `timezone` for DST-aware cron (used by briefing v2: `America/New_York`).

## Outstanding work

1. **Briefing v2 implementation** — design locked (`docs/briefing-v2-design.md`). Seven phases; phase 1 (this commit) done. Next: phase 2 schema migration, then `apps/briefings-web/`, then the three workflow rewrites, Telegram routing, activation + v1 retire + `docs/briefings/*.html` wipe.
2. `newsletter-digest` sibling repo still pending evaluation (carried over from earlier handoffs).
3. Dashboard (`docs/`) static Pages site — news/youtube/podcast/topics RSS feeds are still stale. Briefing feeds are moving to the new Railway site under v2, but these four remain a gap.

## Don't do this again

- Don't write a GitHub Actions workflow to deploy to this n8n instance — Hostinger blocks GitHub runners at L4. Use n8n MCP from Claude Code or the local `scripts/deploy_n8n_workflows.sh` fallback.
- Don't ask the user to copy-paste JSON through the n8n UI. Use `update_workflow` with SDK code, or `create_workflow_from_code`.
- Don't call `.trim()` (or other post-fix methods) on template-literal-defined code strings in SDK files — the validator will reject.
- Don't assume capabilities carry over. MCP servers register per-session; verify at session start.
- Don't touch the `frontier_*` tables from this repo (reads are fine; writes are not). They belong to `unsubject/frontierwatch2`.
- Don't send briefings by email in v2. The Railway site + RSS replace the inbox workflow by design.
