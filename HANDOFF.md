# Handoff — socialisn

_Last updated: 2026-04-20-pm (phase 2.1: 5 studio tools live incl. `check_parking_lot`; briefing v2 shipped; hkcitizensmedia.com live; frontierwatch2 spun off + glossary / GDELT signal shipped; **GDELT phase A (PR #50) merged, deploying to production**)_

## Current state

**Fetch Gmail Subscriptions** — `active: true`, hourly cron `0 * * * *`. Workflow ID `7ZlMNObjAMc26zoR`. Pipeline: Gmail fetch (`label:Subscription`) → normalize → Claude Haiku summary → Postgres upsert into `newsletter_items` → trash email → Zh enrichment → upsert into `item_enrichment`. Source of truth: `n8n/workflows/fetch-gmail-subscriptions.ts`.

**Briefing v2 — shipped 2026-04-20:**

- **Generate Briefing · Morning** (`9ZVO3YdIXpyVFKU2`) — `active: true`. 08:00 ET cron. Fetches last-24h newsletter/news/YouTube/podcast + frontier_briefings + gdelt_signal; Sonnet 4.5 synthesizes; upserts `briefings (slot='morning')`. GDELT signal table injected into prompt (PR #50).
- **Generate Briefing · Update** (`GIncZJ8eJnXz1SzU`) — `active: true`. Consolidated midday+evening with three triggers: 14:00 ET cron, 20:00 ET cron, Telegram message `Update` (slot by time-of-day). Scheduled paths skip-if-exists; Telegram path always regenerates + replies. GDELT signal table injected into prompt (PR #50).
- **Retired**: `Generate Daily Briefing` (`F0g69WDiNUX0OXNW`), the separate Midday (`HBizcBtDaZZ3Lxxq`) and Evening (`lD00GXBo0c9OTuD5`) workflows.

**Briefings site** — `apps/briefings-web/` Hono + pg on Railway. Public URL: **https://hkcitizensmedia.com**.

**Studio service** — `apps/socialisn-studio/` at `https://studio.socialisn.com`. Auth modes:

- **OAuth 2.1 + DCR** (primary) — Settings → Connectors adds URL, auto-registers, password-gated login (`STUDIO_ADMIN_PASSWORD`), 1h access / 30d refresh tokens. Tables: `studio_oauth_clients` / `_codes` / `_tokens`.
- **Legacy bearer** (escape hatch) — `STUDIO_BEARER_TOKEN` for `curl` / `mcp-remote`.

Tools live:

- `search_discourse` — ILIKE RAG across the four source tables + `item_enrichment`.
- `get_cross_source_momentum` — raw momentum primitive (distinct_sources × distinct_mentions × velocity × (1−saturation)).
- `list_daily_candidates` — subjects from `keywords_zh`, track-weighted audience-fit, freshness window, track-distinction, `studio_candidate_scores` telemetry write. `parking_lot_match` now populated via fuzzy title match against Google Tasks (falls back to `false` when Google not configured).
- `build_thesis_brief` — Sonnet-driven thesis sharpener; corpus + Perplexity synthesis; counter-evidence discipline enforced; Traditional Chinese output.
- `check_parking_lot` — reads the Google Tasks "Subjects" list, scores each task's cross-source momentum, classifies as ripe_now/ripe_soon/cold/stale. Requires the Google OAuth env vars (see `docs/google-tasks-setup.md`).

Shared classification helpers (audience-fit regex, saturation penalty, freshness dead-windows) live in `src/lib/scoring.js`. Google Tasks client in `src/google/tasks.js`. Deploy runbook: `docs/studio-deploy.md`.

**Other fetch workflows** — verified active 2026-04-19:

- Fetch News (RSS) `W2QHzmBjyUFs0xsd`
- Fetch Podcasts `Ykpcl95qtvzMv70b`
- Fetch Perplexity Search `rkiWYmYBoVyi8Ih2` (writes into `news_items` with `source_type='perplexity'`)
- Fetch YouTube Videos `x5s2rk7HWNQjX5N1`
- Process Items with Haiku `OG4iOnuMwxoJDbvK` — source of `item_enrichment.keywords_zh`, which both `list_daily_candidates` and `check_parking_lot` depend on.
- **New in PR #50 (deploying now):** `Fetch GDELT Articles` (hourly `:15`) and `Fetch GDELT Signal Daily` (07:30 ET). See §GDELT integration.

## Briefing v2 — design vs. as-built

See `docs/briefing-v2-design.md`. One deviation: midday + evening are a single workflow with three triggers (Telegram bot = one webhook). Pipeline shape unchanged. Phase A GDELT adds a signal table to the Sonnet prompt (PR #50); upstream data sources and synthesis flow unchanged.

## FrontierWatch2 spin-off (2026-04-19)

[`unsubject/frontierwatch2`](https://github.com/unsubject/frontierwatch2) replaced `unsubject/frontierwatch`. Shares this repo's Railway Postgres. Owns `frontier_*` tables. Briefing v2 reads `frontier_briefings` read-only; don't write to `frontier_*` from socialisn.

**Update 2026-04-20-pm:** PRs #1 + #2 add a per-sector glossary (Haiku extractor) + `frontier_signal` GDELT signal layer. New tables `frontier_glossary` and `frontier_signal` + `glossary_processed_at` column on `frontier_briefings`. Still read-only for socialisn. See frontierwatch2/HANDOFF.md for detail.

## GDELT integration — phase A (2026-04-20-pm, PR #50)

Added GDELT 2.0 DOC API as a 4-lane news source feeding existing briefings. Merged via PR #50.

### Lanes (rows in `sources` where `type='gdelt'`)

| Lane | Fetches |
|---|---|
| `hk-core` | HK-local coverage (EN + ZH) via GDELT's global graph |
| `hk-diaspora-rights` | HK-specific rights / transnational cases in UK/CA/AS/TW/US press (BN(O), Jimmy Lai, HK 47, transnational repression, consular cases) |
| `hk-diaspora-hostcountry` | Host-country policy pulse for middle-class conservative diaspora — cost of living, housing, rates, tax, immigration, education, crime, jobs. GDELT themes + `sourcecountry:` filter; no HK keyword. |
| `china-economy` | HSI, H-shares, yuan, PBoC, property developers with `ECON_STOCKMARKET` / `ECON_BANKRUPTCY` / `ECON_HOUSING_PRICES` theme filters |

Query strings live in `sources.config->>'query'` — editable via UPDATE without workflow redeploy.

### Schema (`infra/migrations/0003_gdelt_integration.sql`)

- `news_items.source_subtype TEXT` — lane tag. Covering index on `(source_type, source_subtype, fetched_at)`.
- `gdelt_signal (day, lane, articles, avg_tone, top_source_countries JSONB, top_langs JSONB, top_themes JSONB, fetched_at)` — daily per-lane aggregates, PK `(day, lane)`.
- Idempotent (`IF NOT EXISTS` + `ON CONFLICT`).

### Workflows

- **`fetch-gdelt-articles.ts`** — hourly `15 * * * *`, fan-out across 4 lanes. GDELT DOC 2.0 ArtList mode, `timespan=1h`, `maxrecords=250`. Writes `news_items` rows with `source_type='gdelt'`, `source_subtype=<lane>`, synthetic `lane:<subtype>` in `tags[]`. **No HTTP credential binding required — GDELT is unauthenticated.**
- **`fetch-gdelt-signal-daily.ts`** — daily 07:30 ET (before morning briefing). Per lane: TimelineTone + TimelineSourceCountry + TimelineLang calls. Weighted-avg tone (by bin count) + top-5 countries + top-5 languages. `top_themes` stays `[]` in v1.

### Briefing prompt edits

Both `generate-briefing-morning.ts` and `generate-briefing-update.ts` now inject a compact markdown signal table into the Sonnet prompt when `gdelt_signal` is non-empty:

```
## 全球訊號（GDELT，過去24小時；7日平均為基準）
| 軌道 | 今日文章（量比） | 今日語氣 | 7日平均語氣 | 主要來源國 |
| hk-core | 342 (1.12x) | -2.15 | -1.80 | US, UK, TW |
```

Volume ratio = today / 7d avg; tone range -10..+10. Block omitted when signal is empty. No instruction telling Sonnet to cite it — the model decides interpretation.

### Key design decisions

1. **Four lanes, not three.** `hk-diaspora-*` split into `rights` (narrow HK-specific) + `hostcountry` (broader middle-class diaspora concerns: economy, jobs, tax, housing, education, immigration, safety) so neither crowds out the other's 250-article/hour budget.
2. **Themes > keywords for hostcountry.** GDELT's pre-classified themes (ECON_COST_OF_LIVING, ECON_HOUSING_PRICES, IMMIGRATION, CRIME_VIOLENCE, etc.) beat keyword soup for filtering US/UK/CA press.
3. **Signal table is context, not instruction.** Sonnet receives the numeric table as prompt context with zero directive to cite. Lets the model decide when signal is relevant.
4. **DO NOTHING on article dedup.** When a URL appears in multiple lanes, first-write wins on `source_subtype`. Accepted tradeoff — cross-lane overlap expected low.
5. **Cold start, no backfill.** Past GDELT coverage not retroactively fetched.

### Deploy runbook (post-merge)

1. `psql $DATABASE_URL < infra/migrations/0003_gdelt_integration.sql` on Railway.
2. Deploy `fetch-gdelt-articles` via `mcp__n8n__create_workflow_from_code`. **Skip HTTP credential binding** (GDELT unauthenticated; Postgres auto-assigned).
3. `mcp__n8n__publish_workflow`.
4. Deploy `fetch-gdelt-signal-daily` the same way; publish.
5. `update_workflow` + `publish_workflow` on both briefing workflows (`9ZVO3YdIXpyVFKU2`, `GIncZJ8eJnXz1SzU`) — both active production crons; existing Anthropic binding auto-preserved.
6. After next `:15` fire: `SELECT source_subtype, COUNT(*) FROM news_items WHERE source_type='gdelt' GROUP BY 1;` — should show 4 lanes.
7. After next 07:30 ET: `SELECT * FROM gdelt_signal ORDER BY day DESC, lane;` — 4 rows.
8. Next morning briefing: spot-check the `全球訊號` block rendered in the prompt via n8n run logs.

### Deferred

- Top-themes extraction (GKG-based) into `gdelt_signal.top_themes`.
- Query tuning after 1–2 weeks of real data. Edit via `UPDATE sources SET config = jsonb_set(config, '{query}', '"..."') WHERE type='gdelt' AND name=...;` — no workflow redeploy.

## Phase 2 spec

Full spec: **`docs/phase-2-spec.md`**.

**Phase 2.1 (pre-production)** — studio on Railway; subject shortlisting, parking-lot triage, thesis-brief, script generation. Two distinct tracks (YouTube / podcast) — no subject overlap.

**Phase 2.2 (post-production)** — Whisper SRT cleanup, GEM extraction, title suggestion, YouTube Chapters, teaser.

Interface: remote MCP. New tables: `studio_events`, `studio_candidate_scores` (live), `studio_oauth_*` (live), `whisper_glossary`. Cross-project: session journal entries into `unsubject/2nd-brain` via `src/capture.ts` (channel `socialisn-studio`).

## n8n MCP is wired

`.mcp.json` + `N8N_MCP_URL` / `N8N_MCP_TOKEN`. Verify at session start via `ToolSearch` for `mcp__n8n`. If nothing, add env vars + fresh session.

## Credential names (actual, on instance)

- Postgres: **`Railway`** (not `Postgres`)
- Gmail OAuth2: **`Gmail account`** (n8n, not reused by studio)
- `Anthropic API Key` (httpHeaderAuth, `x-api-key`) — socialisn + frontierwatch2 n8n workflows. Same key can be added to studio as `ANTHROPIC_API_KEY` env var.
- `Perplexity API` (httpBearerAuth) — n8n. Same key → studio `PERPLEXITY_API_KEY`.
- `YouTube API Key` (httpQueryAuth, Name=`key`) — socialisn only.
- `Telegram account` (telegramApi) — Update workflow.
- **Google OAuth (for studio, separate from n8n)** — dedicated OAuth client with `tasks` scope. Client ID / secret / refresh token stored as `STUDIO_GOOGLE_*` env vars. See `docs/google-tasks-setup.md`.

## n8n gotchas (stable invariants)

- **`update_workflow` saves a draft; `publish_workflow` activates.** Silent failure if forgotten. Symptom: `versionId !== activeVersionId`.
- **HTTP Request credentials aren't auto-assigned by MCP.** Bind once in UI after `create_workflow_from_code`. **Exception:** GDELT HTTP nodes are unauthenticated — no binding needed for the two new GDELT workflows.
- **Telegram bot = one webhook.** Two Telegram Triggers on the same bot: last-saved wins.
- `update_workflow` auto-assigns Postgres / Gmail / telegramApi.
- `output: [{...}]` in SDK node defs is editor sample data.
- SDK validator rejects post-fix methods (`.trim()`) on template-literal code strings.
- `runOnceForEachItem` returns `{ json: {...} }`; `runOnceForAllItems` uses `$input.all()`.
- `executeWorkflow` node needs `{ __rl: true, value: 'ID', mode: 'id' }`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` with `fetched_at` filters. **Exception** in GDELT: `DO NOTHING` on `news_items (article_id)` is intentional — first-writer wins on `source_subtype`, cross-lane overlap expected low.
- Gmail node with `simple: false` returns `msg.from` as shape, not string. Use defensive `pickHeader()`.
- `scheduleTrigger` supports `timezone`.
- SDK `fan_in`: multiple triggers into a shared downstream via `.add(secondTrigger).to(sharedNode)`.

## Railway + Cloudflare gotcha

- Cloudflare SSL/TLS must be **Full (strict)**; Flexible → infinite 301 loop.
- Turn CF proxy OFF during initial cert issuance (HTTP-01).

`hkcitizensmedia.com` + `studio.socialisn.com` both fixed using this sequence. Runbook in `docs/studio-deploy.md`.

## Deprecated / removed (2026-04-20)

- `newsletter-digest` sibling repo — cancelled. Newsletter data flows into `newsletter_items` + briefings.
- `docs/` Pages site — fully removed. Only markdown notes remain (`briefing-v2-design.md`, `codebase-review-2026-04-19.md`, `phase-2-spec.md`, `studio-deploy.md`, `google-tasks-setup.md`).
- Transcript enrichment sub-workflow (`VuYc4FsgAxoDNMu7`) — archived. Don't re-add.

## Outstanding work

- **Deploy GDELT phase A (PR #50, merged).** Migration 0003 → deploy 2 new workflows (no cred binding) → update 2 briefing workflows → publish all four. Full runbook in §GDELT integration above.
- **Tune GDELT query strings** after 1–2 weeks of real data. Edit in-place via `UPDATE sources SET config = ...` — no workflow redeploy required.
- **Wire up Google Tasks.** Follow `docs/google-tasks-setup.md`: create OAuth client, run `scripts/google-auth.mjs` once, set `STUDIO_GOOGLE_*` env vars on Railway. Smoke-test `check_parking_lot`, then run `list_daily_candidates` and verify `parking_lot_match` populates for at least one candidate.
- **Phase 2.1 step 6 — `generate_script`.** 30-min Traditional Chinese full-prose script with track-specific CTA (YouTube: members CTA; podcast: curiosity for deeper members content). Reuses `ANTHROPIC_API_KEY` and `STUDIO_SONNET_MODEL`. Prompt structure in spec §"generate_script". Script length 4,500–6,000 Traditional Chinese characters; tune against first real outputs.
- **Phase 2.1 step 7 — `studio_events` + session inference + 2nd-brain journaling + Google Tasks mark-done.** Session = first `list_daily_candidates` to `generate_script` completion (or 4h idle). On close, Haiku writes a narrative journal entry to 2nd-brain via its `POST /capture` (may need to add in 2nd-brain repo first). Also marks the matched parking-lot task `completed` via `markTaskCompleted()` (already exported from `src/google/tasks.js`). Candidate-scoring feedback loop remains out of scope for 2.1 ship per spec.

## Don't do this again

- No GitHub Actions for n8n deploy — Hostinger blocks runners at L4. Use n8n MCP / local script.
- Don't copy-paste JSON through n8n UI; use SDK code.
- Don't `update_workflow` without `publish_workflow` — silent stale active version.
- Don't `.trim()` template-literal code strings in SDK files.
- Don't assume MCP capabilities carry over — verify per session.
- Don't write to `frontier_*` from this repo. **Also applies to `frontier_glossary` and `frontier_signal`** introduced in frontierwatch2 PR #2.
- Don't run two Telegram Triggers on the same bot.
- Don't send briefings by email.
- Don't revive `docs/` Pages site or `newsletter-digest`.
- Don't set Cloudflare SSL/TLS to Flexible on a Railway-backed domain.
- Don't write to existing socialisn ingest tables from studio. Studio is read-only except for its own new tables + Google Tasks mark-done.
- Don't squash-merge a stacked PR without rebasing the child off merged main — orphaned commits, `update_pull_request_branch` fails, PR goes `dirty`. Either merge both in one PR or re-land the child from a fresh cut.
- Don't use Claude Desktop's `"type": "http"` config entry for a bearer-authed remote MCP on Mac; silent fail. Use OAuth via Settings → Connectors, or `mcp-remote` stdio proxy as escape hatch.
- Don't assume the `Gmail account` n8n credential is reachable from the studio — n8n credentials live in n8n's vault. For studio, create a dedicated Google OAuth client.
- **Don't fill the GDELT hostcountry lane with raw keywords** ("cost of living", "inflation", "housing"). GDELT's GKG themes do the filtering work better than keyword soup, and the 250-article hourly cap means keyword-dominant queries get drowned in US press. Keep `theme:` filters + `sourcecountry:` scoping in that lane; tune keywords only in the rights + core lanes.
