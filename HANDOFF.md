# Handoff — socialisn

_Last updated: 2026-04-19 (Fetch Gmail Subscriptions deployed and active)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → Claude Haiku summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Generate Daily Briefing** (`F0g69WDiNUX0OXNW`) — `active: false`. Not touched this deploy.

Other workflows (Fetch News RSS, Fetch Podcasts, Process Items with Haiku, Fetch Perplexity Search, Fetch YouTube Videos) — state not verified this session; refer to prior handoffs and `n8n/workflows/*.ts`.

## n8n MCP is wired

`.mcp.json` + `N8N_MCP_URL` / `N8N_MCP_TOKEN` is configured. At session start verify by calling `ToolSearch` with query `mcp__n8n`. If no tools load, env vars aren't injected — start a fresh session after adding them in Claude Code web settings.

## Credential names (actual, on instance)

- Postgres: **`Railway`** (not `Postgres` — prior handoffs were wrong on this)
- Gmail OAuth2: **`Gmail account`** — confirmed has `gmail.modify` scope; trash step works
- HTTP Header Auth for Anthropic: exists and bound on the two HTTP Request nodes; exact credential name not surfaced by `get_workflow_details`, but `newCredential('Anthropic API Key')` matches it and bindings persist across updates
- `YouTube API Key` (httpQueryAuth, Name=`key`), `Perplexity API` (Bearer) — assumed unchanged

## Update gotcha

`update_workflow` auto-assigns Postgres and Gmail credentials when it recognizes the type. It **skips HTTP Request nodes** — if you see that warning, existing HTTP auth bindings are almost certainly preserved (confirmed in this session). Only worry if you're adding a brand-new HTTP Request node for the first time; in that case bind its credential in the UI.

## n8n SDK gotchas (stable invariants)

- `output: [{...}]` in `@n8n/workflow-sdk` node definitions is editor sample data, not runtime pinned data.
- The SDK validator blocks post-fix methods (e.g. `.trim()`) on template-literal code strings. Define code strings plainly.
- `runOnceForEachItem` Code nodes return `{ json: {...} }`; `runOnceForAllItems` uses `$input.all()` / `$("NodeName").all()` with `pairedItem: { item: k }`.
- `executeWorkflow` node's `workflowId` needs resource locator format: `{ __rl: true, value: 'ID', mode: 'id' }`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` when downstream filters use `fetched_at >= NOW() - INTERVAL 'X hours'`.
- Gmail node with `simple: false` and no explicit `options.format: 'full'` returns `msg.from` as `{ text, html, value[] }` — NOT a string. `.match()` on it crashes. Use a defensive `pickHeader()` that handles multiple shapes (see `fetch-gmail-subscriptions.ts`).

## Outstanding work

1. Other workflows' state is unchecked this session. Before editing any of them, run `get_workflow_details` and compare to `n8n/workflows/*.ts`. Git is source of truth.
2. `Generate Daily Briefing` (`F0g69WDiNUX0OXNW`) is not active — decide whether and when to activate.
3. Frontierwatch and newsletter-digest sibling repos still pending migration (carried over).

## Don't do this again

- Don't write a GitHub Actions workflow to deploy to this n8n instance — Hostinger blocks GitHub runners at L4. Use n8n MCP from Claude Code or the local `scripts/deploy_n8n_workflows.sh` fallback.
- Don't ask the user to copy-paste JSON through the n8n UI. Use `update_workflow` with SDK code, or `create_workflow_from_code`.
- Don't call `.trim()` (or other post-fix methods) on template-literal-defined code strings in SDK files — the validator will reject.
- Don't assume capabilities carry over. MCP servers register per-session; verify at session start.
