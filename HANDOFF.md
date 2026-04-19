# Handoff — socialisn

_Last updated: 2026-04-19 (frontierwatch2 spun off; this repo unchanged)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → Claude Haiku summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Generate Daily Briefing** (`F0g69WDiNUX0OXNW`) — `active: false`. Redesign deferred (user paused to build FrontierWatch2 first).

Other workflows (Fetch News RSS, Fetch Podcasts, Process Items with Haiku, Fetch Perplexity Search, Fetch YouTube Videos) — state not verified this session; refer to prior handoffs and `n8n/workflows/*.ts`.

## FrontierWatch2 spin-off (2026-04-19)

A sibling private repo [`unsubject/frontierwatch2`](https://github.com/unsubject/frontierwatch2) was created to replace `unsubject/frontierwatch` (POC → production rewrite). It shares this repo's Railway Postgres and owns three new tables: `frontier_watches`, `frontier_briefings`, `frontier_watchlist`. Six sector workflows live on the n8n instance (names prefixed `FrontierWatch2 · `):
- `computing-ai` is active and validated end-to-end
- `economics`, `monetary-policy`, `biotech`, `energy`, `securities-futures` are created but need HTTP credential binding + publish

All further work on FrontierWatch happens in that repo's HANDOFF.md. Don't touch `frontier_*` tables from socialisn.

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

## Outstanding work

1. Other socialisn workflows' state unchecked this session. Before editing any of them, run `get_workflow_details` and compare to `n8n/workflows/*.ts`. Git is source of truth.
2. `Generate Daily Briefing` redesign — paused mid-interview; resume when the user returns to this topic.
3. `newsletter-digest` sibling repo still pending evaluation (carried over from earlier handoffs; frontierwatch migration is done, this one remains).
4. Dashboard (`docs/`) is a static GitHub Pages site with RSS feeds but **no workflow writes to it** — feeds are stale snapshots. Identified as an active gap.

## Don't do this again

- Don't write a GitHub Actions workflow to deploy to this n8n instance — Hostinger blocks GitHub runners at L4. Use n8n MCP from Claude Code or the local `scripts/deploy_n8n_workflows.sh` fallback.
- Don't ask the user to copy-paste JSON through the n8n UI. Use `update_workflow` with SDK code, or `create_workflow_from_code`.
- Don't call `.trim()` (or other post-fix methods) on template-literal-defined code strings in SDK files — the validator will reject.
- Don't assume capabilities carry over. MCP servers register per-session; verify at session start.
- Don't touch the `frontier_*` tables from this repo. They belong to `unsubject/frontierwatch2`.
