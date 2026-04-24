# Handoff — socialisn

_Last updated: 2026-04-24 (phase 2.1: 5 studio tools live incl. `check_parking_lot`; briefing v2 shipped; hkcitizensmedia.com live; frontierwatch2 spun off + glossary / GDELT signal shipped; GDELT phase A deployed; **Haiku enrichment migrated to OpenAI gpt-5.4-nano — deploy in progress**)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → OpenAI Nano summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment (Nano) → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Briefing v2 — shipped 2026-04-20:**

- **Generate Briefing · Morning** (`9ZVO3YdIXpyVFKU2`) — `active: true`. 08:00 ET cron. Fetches last-24h newsletter/news/YouTube/podcast + frontier_briefings + gdelt_signal; Sonnet 4.5 synthesizes; upserts `briefings (slot='morning')`. GDELT signal table injected into prompt.
- **Generate Briefing · Update** (`GIncZJ8eJnXz1SzU`) — `active: true`. Consolidated midday+evening with three triggers: 14:00 ET cron, 20:00 ET cron, Telegram message `Update` (slot by time-of-day). Scheduled paths skip-if-exists; Telegram path always regenerates + replies. GDELT signal table injected into prompt.
- **Retired**: `Generate Daily Briefing` (`F0g69WDiNUX0OXNW`), the separate Midday (`HBizcBtDaZZ3Lxxq`) and Evening (`lD00GXBo0c9OTuD5`) workflows.

**Briefings site** — `apps/briefings-web/` Hono + pg on Railway. Public URL: **https://hkcitizensmedia.com**.

**Studio service** — `apps/socialisn-studio/` at `https://studio.socialisn.com`. Auth modes:

- **OAuth 2.1 + DCR** (primary) — Settings → Connectors adds URL, auto-registers, password-gated login (`STUDIO_ADMIN_PASSWORD`), 1h access / 30d refresh tokens. Tables: `studio_oauth_clients` / `_codes` / `_tokens`.
- **Legacy bearer** (escape hatch) — `STUDIO_BEARER_TOKEN` for `curl` / `mcp-remote`.

Tools live:

- `search_discourse` — ILIKE RAG across the four source tables + `item_enrichment`.
- `get_cross_source_momentum` — raw momentum primitive (distinct_sources × distinct_mentions × velocity × (1−saturation)).
- `list_daily_candidates` — subjects from `keywords_zh`, track-weighted audience-fit, freshness window, track-distinction, `studio_candidate_scores` telemetry write. `parking_lot_match` populated via fuzzy title match against Google Tasks.
- `build_thesis_brief` — Sonnet-driven thesis sharpener; corpus + Perplexity synthesis; counter-evidence discipline enforced; Traditional Chinese output.
- `check_parking_lot` — reads the Google Tasks "Subjects" list, scores each task's cross-source momentum, classifies as ripe_now/ripe_soon/cold/stale. Requires the Google OAuth env vars (see `docs/google-tasks-setup.md`).

Shared classification helpers live in `src/lib/scoring.js`. Google Tasks client in `src/google/tasks.js`. Deploy runbook: `docs/studio-deploy.md`.

**Other fetch workflows** — verified active 2026-04-19:

- Fetch News (RSS) `W2QHzmBjyUFs0xsd`
- Fetch Podcasts `Ykpcl95qtvzMv70b`
- Fetch Perplexity Search `rkiWYmYBoVyi8Ih2` (writes into `news_items` with `source_type='perplexity'`)
- Fetch YouTube Videos `x5s2rk7HWNQjX5N1`
- Process Items with Nano `OG4iOnuMwxoJDbvK` (file: `process-haiku.ts` — filename retained, workflow renamed) — source of `item_enrichment.keywords_zh`, which both `list_daily_candidates` and `check_parking_lot` depend on.
- **New (GDELT phase A, deploying now):** `Fetch GDELT Articles` (hourly `:15`) and `Fetch GDELT Signal Daily` (07:30 ET). See §GDELT integration.

## FrontierWatch2 spin-off (2026-04-19)

[`unsubject/frontierwatch2`](https://github.com/unsubject/frontierwatch2) replaced `unsubject/frontierwatch`. Shares this repo's Railway Postgres. Owns `frontier_*` tables. Briefing v2 reads `frontier_briefings` read-only; don't write to `frontier_*` from socialisn.

**Update 2026-04-20-pm:** frontierwatch2 PRs #1 + #2 add a per-sector glossary (Haiku extractor) + `frontier_signal` GDELT signal layer. New tables `frontier_glossary` and `frontier_signal` + `glossary_processed_at` column on `frontier_briefings`. Still read-only for socialisn. See frontierwatch2/HANDOFF.md.

## Haiku → OpenAI Nano migration (2026-04-24)

Two n8n workflows rewritten to call OpenAI `chat/completions` with `model: "gpt-5.4-nano"` instead of Anthropic Haiku:

- `fetch-gmail-subscriptions.ts` (`7ZlMNObjAMc26zoR`) — both HTTP calls (English summary + Zh enrichment).
- `process-haiku.ts` (`OG4iOnuMwxoJDbvK`) — single enrichment call. Filename unchanged to preserve workflow mapping; display name now "Process Items with Nano".

### Call-shape changes

- URL: `api.anthropic.com/v1/messages` → `api.openai.com/v1/chat/completions`.
- Body: `{ model, max_tokens, system, messages }` (Anthropic shape) → `{ model, max_completion_tokens, messages }` (OpenAI shape, system folded in as a role-`system` message). Dropped `cache_control: ephemeral` — OpenAI caches automatically for long prefixes.
- Header: dropped `anthropic-version`. OpenAI just needs `Authorization: Bearer` via the `OpenAI API Key` credential.
- Response parse: `response.content[0].text` → `response.choices[0].message.content`.

Briefing workflows (Sonnet) and studio tools (Sonnet) are untouched — the swap is Haiku-only.

### Deploy runbook

1. Merge PR to `main`.
2. `mcp__n8n__update_workflow` with both workflow IDs using the new code.
3. Bind `OpenAI API Key` credential to each HTTP Request node manually in n8n UI (SDK doesn't auto-bind HTTP creds — standing invariant).
4. `mcp__n8n__publish_workflow` both.
5. Verify on next cron tick:
   - `SELECT message_id, summary IS NOT NULL AS ok FROM newsletter_items WHERE received_at >= NOW() - INTERVAL '2 hours' ORDER BY received_at DESC LIMIT 10;`
   - `SELECT item_type, COUNT(*) FROM item_enrichment WHERE processed_at >= NOW() - INTERVAL '6 hours' GROUP BY 1;`

### Open questions

- `max_completion_tokens` is the GPT-5-family parameter (reasoning models rejected `max_tokens`). If Nano doesn't gate on reasoning tokens, 256 / 1024 budgets may need bumping after first run.
- Output is raw text; both Code parse nodes still strip leading ``` ```json ``` fences before `JSON.parse`, so behaviour matches Haiku's occasional fenced output.
- Studio does not yet consume OpenAI (Sonnet stays on Claude). If that changes, add `OPENAI_API_KEY` to Railway service env.

## GDELT integration — phase A (2026-04-20-pm)

4-lane GDELT 2.0 DOC API news source feeding existing briefings.

### Lanes (rows in `sources` where `type='gdelt'`)

| Lane | Fetches |
|---|---|
| `hk-core` | HK-local coverage (EN + ZH) |
| `hk-diaspora-rights` | HK-specific rights / transnational cases in UK/CA/AS/TW/US press |
| `hk-diaspora-hostcountry` | Host-country policy pulse for middle-class conservative diaspora (GDELT themes + sourcecountry filter) |
| `china-economy` | HSI, H-shares, yuan, PBoC, property developers with ECON_* theme filters |

Query strings in `sources.config->>'query'` — editable via UPDATE without workflow redeploy.

### Schema (`infra/migrations/0003_gdelt_integration.sql`)

- `news_items.source_subtype TEXT` (lane tag) + covering index.
- `gdelt_signal (day, lane, articles, avg_tone, top_source_countries JSONB, top_langs JSONB, top_themes JSONB)`, PK `(day, lane)`.
- Idempotent (`IF NOT EXISTS` + `ON CONFLICT`).

### Workflows

- `fetch-gdelt-articles.ts` — hourly `15 * * * *`, fan-out across 4 lanes. **GDELT unauthenticated — no HTTP credential binding needed.**
- `fetch-gdelt-signal-daily.ts` — daily 07:30 ET. TimelineTone + TimelineSourceCountry + TimelineLang per lane.

### Briefing prompt edits

Both briefing workflows inject a compact markdown signal table into the Sonnet prompt when `gdelt_signal` is non-empty:

```
## 全球訊號（GDELT，過去24小時；7日平均為基準）
| 軌道 | 今日文章（量比） | 今日語氣 | 7日平均語氣 | 主要來源國 |
| hk-core | 342 (1.12x) | -2.15 | -1.80 | US, UK, TW |
```

Block omitted when signal empty. No directive to Sonnet — model decides.

### Key design decisions

1. **Four lanes, not three.** `hk-diaspora-*` split into `rights` (HK-specific) + `hostcountry` (broader middle-class diaspora concerns) so neither crowds out the other's 250-article/hour budget.
2. **Themes > keywords for hostcountry.** GDELT's pre-classified themes beat keyword soup for filtering US/UK/CA press.
3. **Signal table is context, not instruction.** Sonnet decides when to cite.
4. **DO NOTHING on article dedup.** First-lane-writer wins on `source_subtype`.
5. **Cold start, no backfill.**

### Deploy runbook

1. `psql $DATABASE_URL < infra/migrations/0003_gdelt_integration.sql` on Railway.
2. `mcp__n8n__create_workflow_from_code` for `fetch-gdelt-articles` + `publish_workflow`. No HTTP credential binding.
3. Same for `fetch-gdelt-signal-daily`.
4. `mcp__n8n__update_workflow` + `publish_workflow` for both briefing workflows (`9ZVO3YdIXpyVFKU2`, `GIncZJ8eJnXz1SzU`). Existing Anthropic binding preserved.
5. Verify after next cron: `SELECT source_subtype, COUNT(*) FROM news_items WHERE source_type='gdelt' GROUP BY 1;` + `SELECT * FROM gdelt_signal;`.

### Deferred

- Top-themes extraction (GKG-based).
- Query tuning after 1–2 weeks: `UPDATE sources SET config = jsonb_set(config, '{query}', '"..."') WHERE type='gdelt' AND name=...;`.

## Briefing v2 — design vs. as-built

See `docs/briefing-v2-design.md`. One deviation: midday + evening are a single workflow with three triggers (Telegram bot = one webhook). GDELT phase A adds a signal table to Sonnet prompt — upstream data sources + synthesis flow unchanged.

## Phase 2 spec

Full spec: **`docs/phase-2-spec.md`**.

**Phase 2.1 (pre-production)** — studio on Railway; subject shortlisting, parking-lot triage, thesis-brief, script generation. Two distinct tracks (YouTube / podcast).

**Phase 2.2 (post-production)** — Whisper SRT cleanup, GEM extraction, title suggestion, YouTube Chapters, teaser.

Interface: remote MCP. New tables: `studio_events`, `studio_candidate_scores` (live), `studio_oauth_*` (live), `whisper_glossary`. Cross-project: session journal entries into `unsubject/2nd-brain` via `src/capture.ts` (channel `socialisn-studio`).

## n8n MCP is wired

`.mcp.json` + `N8N_MCP_URL` / `N8N_MCP_TOKEN`. Verify at session start via `ToolSearch` for `mcp__n8n`.

## Credential names (actual, on instance)

- Postgres: **`Railway`** (not `Postgres`)
- Gmail OAuth2: **`Gmail account`** (n8n)
- `Anthropic API Key` (httpHeaderAuth, `x-api-key`) — briefing workflows (Sonnet) + frontierwatch2. Same key → studio `ANTHROPIC_API_KEY`.
- `OpenAI API Key` (httpHeaderAuth, `Authorization: Bearer <key>`) — Nano enrichment workflows (Gmail + Process Items). n8n-only for now; add `OPENAI_API_KEY` to Railway if studio tools ever migrate.
- `Perplexity API` (httpBearerAuth) — n8n → studio `PERPLEXITY_API_KEY`.
- `YouTube API Key` (httpQueryAuth, Name=`key`) — socialisn only.
- `Telegram account` (telegramApi) — Update workflow.
- **Google OAuth (studio-only)** — `STUDIO_GOOGLE_*` env vars. See `docs/google-tasks-setup.md`.

## n8n gotchas (stable invariants)

- **`update_workflow` saves a draft; `publish_workflow` activates.** Silent failure if forgotten.
- **HTTP Request credentials aren't auto-assigned by MCP.** Bind once in UI. **Exception:** GDELT HTTP nodes unauthenticated — no binding needed.
- **Telegram bot = one webhook.** Two Triggers on same bot: last-saved wins.
- `update_workflow` auto-assigns Postgres / Gmail / telegramApi.
- `output: [{...}]` in SDK is editor sample data.
- SDK validator rejects post-fix methods (`.trim()`) on template-literal code strings.
- `runOnceForEachItem` returns `{ json: {...} }`; `runOnceForAllItems` uses `$input.all()`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` with `fetched_at` filters. **Exception:** GDELT uses `DO NOTHING` on `news_items (article_id)` — first-writer wins on `source_subtype`.
- Gmail node with `simple: false` returns `msg.from` as shape, not string.
- `scheduleTrigger` supports `timezone`.
- **OpenAI chat/completions uses `max_completion_tokens` (not `max_tokens`) for the GPT-5 family.** Dropping the old key silently caps output at default. Response shape is `choices[0].message.content`.

## Railway + Cloudflare gotcha

- Cloudflare SSL/TLS must be **Full (strict)**; Flexible → 301 loop.
- Turn CF proxy OFF during initial cert issuance (HTTP-01).

Runbook in `docs/studio-deploy.md`.

## Deprecated / removed (2026-04-20)

- `newsletter-digest` sibling repo — cancelled.
- `docs/` Pages site — removed. Only markdown notes remain.
- Transcript enrichment sub-workflow (`VuYc4FsgAxoDNMu7`) — archived.

## Outstanding work

- **Haiku → OpenAI Nano deploy** (2026-04-24). PR on branch `haiku-to-gpt-5-nano`. After merge: `update_workflow` + `publish_workflow` on `7ZlMNObjAMc26zoR` and `OG4iOnuMwxoJDbvK`; bind `OpenAI API Key` cred to all three HTTP Request nodes in n8n UI; watch first cron run for 401s / empty `summary` columns / `max_completion_tokens` caps.
- **GDELT phase A deploy in progress.** Migration 0003 + 2 new workflows + 2 briefing prompt edits merged to main. Deploy steps per §GDELT deploy runbook. Direct-to-main bypass used because PR #50 hit a `dirty` state after parallel studio PRs landed on main; code content verified identical to PR #50's final state.
- **Tune GDELT query strings** after 1–2 weeks. Edit in-place via `UPDATE sources SET config = ...`.
- **Wire up Google Tasks.** Follow `docs/google-tasks-setup.md`: create OAuth client, run `scripts/google-auth.mjs`, set `STUDIO_GOOGLE_*` env vars on Railway. Smoke-test `check_parking_lot`.
- **Phase 2.1 step 6 — `generate_script`.** 30-min Traditional Chinese full-prose script with track-specific CTA. Reuses `ANTHROPIC_API_KEY` + `STUDIO_SONNET_MODEL`. Script length 4,500–6,000 chars.
- **Phase 2.1 step 7 — `studio_events` + session inference + 2nd-brain journaling + Google Tasks mark-done.** Session = first `list_daily_candidates` → `generate_script` completion (or 4h idle). On close: narrative journal into 2nd-brain via `POST /capture`; mark matched parking-lot task `completed` via `markTaskCompleted()`.

## Don't do this again

- No GitHub Actions for n8n deploy — Hostinger blocks runners at L4.
- Don't copy-paste JSON through n8n UI; use SDK code.
- Don't `update_workflow` without `publish_workflow`.
- Don't `.trim()` template-literal code strings in SDK.
- Don't assume MCP capabilities carry over — verify per session.
- Don't write to `frontier_*` from this repo. **Also applies to `frontier_glossary` + `frontier_signal`.**
- Don't run two Telegram Triggers on the same bot.
- Don't send briefings by email.
- Don't revive `docs/` Pages site or `newsletter-digest`.
- Don't set Cloudflare SSL/TLS to Flexible on a Railway-backed domain.
- Don't write to existing socialisn ingest tables from studio.
- Don't squash-merge a stacked PR without rebasing the child off merged main — orphaned commits, `update_pull_request_branch` fails, PR goes `dirty`.
- **When a feature branch's PR conflicts on HANDOFF.md after parallel main movement, consider direct-to-main push for individual files via `create_or_update_file` (per-file SHA) rather than trying to merge-through.** Saved this GDELT phase A deploy after PR #50 went `dirty`.
- Don't use Claude Desktop's `"type": "http"` config entry for a bearer-authed remote MCP on Mac; silent fail.
- Don't assume the `Gmail account` n8n credential is reachable from studio — separate OAuth clients.
- **Don't fill the GDELT hostcountry lane with raw keywords** ("cost of living", "inflation"). GDELT themes + `sourcecountry:` scoping beat keyword soup.
- **Don't send `max_tokens` to OpenAI GPT-5-family models.** Use `max_completion_tokens`. And don't leave `cache_control: ephemeral` in the body when porting from Anthropic — OpenAI rejects unknown fields on some models.
