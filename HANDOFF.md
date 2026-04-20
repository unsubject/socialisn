# Handoff — socialisn

_Last updated: 2026-04-20 (phase 2 spec drafted — `docs/phase-2-spec.md`; briefing v2 shipped; Pages site fully removed; hkcitizensmedia.com live on Railway; newsletter-digest deprecated; frontierwatch2 spun off 2026-04-19; Fetch YouTube republished after stale draft left deprecated sub-workflow call in active version)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → Claude Haiku summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Briefing v2 — shipped 2026-04-20:**

- **Generate Briefing · Morning** (`9ZVO3YdIXpyVFKU2`) — `active: true`. 08:00 ET cron. Fetches last-24h newsletter/news/YouTube/podcast + frontier_briefings; Sonnet 4.5 synthesizes; frontier content appended verbatim; upserts `briefings (slot='morning')`. Source of truth: `n8n/workflows/generate-briefing-morning.ts`.
- **Generate Briefing · Update** (`GIncZJ8eJnXz1SzU`) — `active: true`. Consolidated midday+evening in one workflow with three triggers: 14:00 ET cron → `slot='midday'`, 20:00 ET cron → `slot='evening'`, Telegram message `Update` → slot picked by ET time-of-day (before 17:00 → midday, else evening). Scheduled paths skip-if-exists; Telegram path always regenerates and replies to chat. Source of truth: `n8n/workflows/generate-briefing-update.ts`.
- **Retired**: `Generate Daily Briefing` (`F0g69WDiNUX0OXNW`) archived. The separate `Generate Briefing · Midday` (`HBizcBtDaZZ3Lxxq`) and `Generate Briefing · Evening` (`lD00GXBo0c9OTuD5`) were also archived after consolidation.

**Briefings site** — `apps/briefings-web/` Hono + pg service on Railway, renders `briefings.html` directly from Postgres. Routes: `/`, `/b/:date/:slot`, `/archive`, `/feed.xml`, `/healthz`. Public URL: **https://hkcitizensmedia.com** (custom domain live 2026-04-20, fronted by Cloudflare, Railway-issued Let's Encrypt cert). This is the canonical feed surface going forward.

**Other fetch workflows** — verified active 2026-04-19:

- Fetch News (RSS) `W2QHzmBjyUFs0xsd`
- Fetch Podcasts `Ykpcl95qtvzMv70b`
- Fetch Perplexity Search `rkiWYmYBoVyi8Ih2`
- Fetch YouTube Videos `x5s2rk7HWNQjX5N1`
- Process Items with Haiku `OG4iOnuMwxoJDbvK`

Before editing any of them, run `get_workflow_details` and diff against `n8n/workflows/*.ts`. Git is source of truth. **After every `update_workflow`, also call `publish_workflow`** — otherwise the fix stays on the draft and the active cron keeps running the old version (see gotcha below).

## Briefing v2 — design vs. as-built

Full design in `docs/briefing-v2-design.md`. One deviation shipped: midday and evening are implemented as a **single `Generate Briefing · Update` workflow with three triggers** rather than two separate workflows. Driver: a Telegram bot can only target one webhook URL, so two workflows each with a Telegram Trigger was an anti-pattern. Consolidating lets one Telegram Trigger own the webhook and pick slot by ET time-of-day. The design doc's pipeline shape (cutoff → fetch delta → build prompt → Sonnet → combine → save) is unchanged.

The single magic word is `Update` (case-sensitive, plain message). Filtered via IF node right after the Telegram Trigger; any other text is silently ignored.

## FrontierWatch2 spin-off (2026-04-19)

Sibling private repo [`unsubject/frontierwatch2`](https://github.com/unsubject/frontierwatch2) replaced `unsubject/frontierwatch` (POC → production rewrite). Shares this repo's Railway Postgres and owns `frontier_watches`, `frontier_briefings`, `frontier_watchlist`. Six sector workflows live on the n8n instance (names prefixed `FrontierWatch2 · `):

- `computing-ai` active and validated end-to-end
- `economics`, `monetary-policy`, `biotech`, `energy`, `securities-futures` created but need HTTP credential binding + publish

All FrontierWatch work happens in that repo's HANDOFF.md. The briefing v2 pipeline reads `frontier_briefings` read-only; don't write to `frontier_*` from socialisn.

## Phase 2 — in planning (2026-04-20)

Full spec: **`docs/phase-2-spec.md`** — read before starting any phase 2 implementation.

Summary:

- **Phase 2.1 (pre-production)**: MCP server `socialisn-studio` on Railway at `studio.socialisn.com`, exposing tools for subject shortlisting, Google Tasks "Subjects" parking-lot triage, thesis-brief with evidence + counter-evidence, and 30-min Traditional Chinese script generation. Two **distinct** daily tracks (YouTube broad-reach / members podcast deep-dive) — no subject overlap.
- **Phase 2.2 (post-production)**: adds tools for Whisper SRT cleanup, GEM extraction, title suggestion, YouTube Chapters, teaser. Shipped after 2.1.
- **Interface**: remote MCP — user connects from Claude / Gemini / ChatGPT / Perplexity. No new UI in this repo.
- **New tables**: `studio_events`, `studio_candidate_scores`, `whisper_glossary`. All other socialisn tables are read-only from the studio.
- **Cross-project**: every session writes a human-readable journal entry into `unsubject/2nd-brain` via its `src/capture.ts` ingestion contract (`channel: "socialisn-studio"`), so production behavior becomes semantically searchable alongside other journal entries.

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

- **`update_workflow` saves a draft; you must `publish_workflow` to activate it.** The cron keeps running the previous active version until you publish. Silent failure mode: fixes appear merged in repo + n8n UI draft, but production behavior is unchanged. Symptom: `get_workflow_details` returns `versionId !== activeVersionId`, and `activeVersion.nodes` differs from top-level `nodes`. Seen 2026-04-20 on Fetch YouTube Videos — deprecated `Trigger Transcript Enrichment` sub-workflow call (targeting long-archived `VuYc4FsgAxoDNMu7`) stayed in the active version for days because the cleanup was only saved to draft.
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

## Railway + Cloudflare gotcha

For any Railway service fronted by Cloudflare at a custom domain:

- **Cloudflare SSL/TLS mode must be "Full (strict)"**, not "Flexible". Flexible sends HTTP to Railway; Railway responds with a 301 to HTTPS; CF serves that 301 back; browser retries HTTPS; infinite loop. Symptom: `curl -I https://<domain>/healthz` returns `HTTP/2 301` with `location` header pointing at the *same* URL, plus `server: cloudflare`.
- **Turn CF proxy OFF (grey cloud) during initial cert issuance.** Railway issues Let's Encrypt certs via HTTP-01; the orange-cloud proxy intercepts the challenge and the cert never issues. Once the cert is active on the Railway side, you can flip the proxy back on (and SSL mode must be Full strict by then).

`hkcitizensmedia.com` was fixed using exactly this sequence on 2026-04-20. Re-apply this runbook for `studio.socialisn.com` when phase 2.1 deploys.

## Deprecated / removed (2026-04-20)

- **`newsletter-digest` sibling repo** — evaluation cancelled; out of scope. Newsletter data already flows into `newsletter_items` via the Gmail workflow and into every v2 briefing via the read-only join. No separate digest pipeline needed.
- **`docs/` Pages site — fully removed.** All deprecated static assets (`feed.xml`, `podcast-feed.xml`, `topics-feed.xml`, `youtube-feed.xml`, `index.html`, `briefings/*.html`) are gone. The Railway `apps/briefings-web/` service is the only feed/briefing surface. `docs/` now holds only markdown design/review notes (`briefing-v2-design.md`, `codebase-review-2026-04-19.md`, `phase-2-spec.md`).
- **Transcript enrichment sub-workflow** — archived workflow `VuYc4FsgAxoDNMu7` is gone; transcript enrichment is not part of the pipeline. Per-item Traditional Chinese summary + keyword enrichment is now handled centrally by `Process Items with Haiku` (`OG4iOnuMwxoJDbvK`) polling every source table. Do not re-add a `Trigger Transcript Enrichment` node at the tail of any fetch workflow.

## Outstanding work

- Begin **Phase 2.1** implementation per `docs/phase-2-spec.md`. Build order in the spec §"Build order (Phase 2.1)". Start with MCP scaffolding at `apps/socialisn-studio/` + Cloudflare DNS + cert runbook for `studio.socialisn.com`.

## Don't do this again

- Don't write a GitHub Actions workflow to deploy to this n8n instance — Hostinger blocks GitHub runners at L4. Use n8n MCP from Claude Code or the local `scripts/deploy_n8n_workflows.sh` fallback.
- Don't ask the user to copy-paste JSON through the n8n UI. Use `update_workflow` with SDK code, or `create_workflow_from_code`.
- Don't call `update_workflow` without following it with `publish_workflow`. The draft/active split is silent — without publishing, the cron keeps running the previous active version and your fix is invisible in production.
- Don't call `.trim()` (or other post-fix methods) on template-literal-defined code strings in SDK files — the validator will reject.
- Don't assume capabilities carry over. MCP servers register per-session; verify at session start.
- Don't touch the `frontier_*` tables from this repo (reads are fine; writes are not). They belong to `unsubject/frontierwatch2`.
- Don't put a Telegram Trigger on more than one workflow bound to the same bot — only one will survive.
- Don't send briefings by email. The Railway site + DB replace that path by design.
- Don't revive the `docs/` Pages site or `newsletter-digest` — both deprecated 2026-04-20.
- Don't set Cloudflare SSL/TLS mode to "Flexible" on any Railway-backed domain — guaranteed redirect loop.
- Don't write to existing socialisn ingest tables from `socialisn-studio` (phase 2). Studio is read-only for everything except its own new tables and the Google Tasks "Subjects" mark-done action.
