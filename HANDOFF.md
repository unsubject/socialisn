# Handoff — socialisn migration to n8n

_Last updated: 2026-04-18. Pick up from here at session start._

## TL;DR

Migrating the socialisn pipeline from git-committed JSON + GitHub Actions to
n8n (self-hosted) + Postgres (Railway). Fetchers + enrichment are done; the
two user-facing deliverables (email briefing + dashboard) still need work.
Also planning to absorb two sibling repos into the same pipeline.

Working branch: `claude/run-briefing-script-7xbIt` (all changes push here).

## Current state

### ✅ Done and tested (verified producing rows in Postgres)

| Workflow | File | n8n ID | Schedule (UTC) | Writes to |
|---|---|---|---|---|
| Fetch YouTube | `n8n/workflows/fetch-youtube.ts` | `x5s2rk7HWNQjX5N1` | `0 4,10,16,22` | `youtube_items` |
| Fetch News RSS | `n8n/workflows/fetch-news-rss.ts` | _look up in n8n UI_ | `0 */6` | `news_items` |
| Fetch Perplexity | `n8n/workflows/fetch-perplexity.ts` | _look up in n8n UI_ | `25 0,6,12,18` | `news_items` (type=perplexity) |
| Fetch Podcasts | `n8n/workflows/fetch-podcasts.ts` | _look up in n8n UI_ | `0 1,7,13,19` | `podcast_items` |
| Process Haiku | `n8n/workflows/process-haiku.ts` | _look up in n8n UI_ | `45 4,10,16,22` | `item_enrichment` |

### 🗑 Deprecated (do not resurrect without IP-blocking fix)

- **YouTube transcript retrieval** — YouTube returns 429 / `google.com/sorry`
  for Railway datacenter IPs. Both `youtube-transcript-api` and `yt-dlp` fail.
  Cookie-based auth would work but adds operational burden. Decision: ship
  without transcripts; title + description is enough signal.
  - Archived n8n workflow: `VuYc4FsgAxoDNMu7`
  - Removed `/youtube-transcript` + `/debug/transcript` from py-helpers
  - Removed `youtube-transcript-api` and `yt-dlp` deps
  - `youtube_items.transcript_*` columns remain (NULL) — drop later if desired

### 🔧 Outstanding

1. **`generate-briefing`** — scaffolded at `n8n/workflows/generate-briefing.ts`
   (schedule `30 23 * * *`, writes to `briefings`, sends via Gmail). Needs
   fine-tuning: prompt quality, email HTML layout, slot logic (early/evening),
   recipient list. Reference the existing Python in
   `scripts/generate_briefing.py` — prompt structure at L149-199, markdown→HTML
   at L267-321, Chinese typography (PingFang HK, Microsoft JhengHei, #d4a017
   accent).

2. **`publish-dashboard`** — not yet built. Needs to render HTML + RSS from
   Postgres and push to `docs/*` via the GitHub API (so GitHub Pages stays
   the dashboard host). Reference Python: `scripts/generate_dashboard.py`,
   `scripts/generate_rss.py`, `scripts/generate_youtube_rss.py`,
   `scripts/generate_podcast_rss.py`, `scripts/generate_topics_rss.py`.

3. **Integration with sibling repos** (new in this session):
   - `unsubject/frontierwatch` — description: "Frontier Devs in Energy,
     Information Technology, BioTech." Python project, ~36 commits. Full
     purpose still unknown to me (README fetch returned 404) — **ask the user
     at session start** what it ingests and produces, or clone and read.
   - `unsubject/newsletter-digest` — processes Gmail messages with
     "Subscription" label via Claude Haiku, extracts news items (filtering
     ads), emits RSS 2.0 on GitHub Pages, runs daily 07:00 UTC via GHA.
   - **Plan**: migrate each into an n8n workflow + Postgres table (probably
     re-using `news_items` for newsletter-digest output, TBD for frontierwatch
     depending on its data shape), then archive the GitHub repos.

## Architecture (for context)

```
Railway:
  ├─ n8n (self-hosted)           — orchestration, API calls, Anthropic/Gmail
  ├─ Postgres                    — n8n DB + app DB in one instance
  └─ py-helpers (FastAPI)        — Python-only ops: /scrape-article,
                                   /parse-google-trends
                                   URL: https://socialisn-production.up.railway.app

GitHub (kept):
  └─ unsubject/socialisn         — configs, docs/ (GitHub Pages), this repo
```

## Database schema (app tables)

Defined in `infra/init.sql`. Key tables:

- `sources(id, type, name, language, tags[], config JSONB, enabled)` — runtime config for all fetchers. Seeded by `infra/seed_sources.sql`.
- `youtube_items`, `news_items`, `podcast_items` — raw fetched items
- `item_enrichment(item_type, item_id, summary_zh, keywords_zh[], processed_at)` — joined 1:1 to raw items
- `briefings(date, slot, markdown, html, email_sent_at, ...)` — UNIQUE(date, slot)

## n8n credentials in use

- `Postgres` — DB connection
- `Anthropic API Key` — Haiku + Sonnet (via HTTP node)
- `Gmail OAuth2` — email send (for generate-briefing)
- `YouTube API Key` — `httpQueryAuth` with Name=`key`, Value=API key
- `Perplexity API` — Bearer token

## n8n SDK gotchas learned this session

- `output: [{...}]` on nodes is **sample data for the editor only**, not
  runtime pinned data. Don't rely on it in downstream nodes.
- `runOnceForEachItem` Code nodes must return a single `{json: {...}}`;
  `runOnceForAllItems` returns arrays with `$input.all()` and
  `$("NodeName").all()`, using `pairedItem: { item: k }` for lineage.
- `executeWorkflow` node's `workflowId` needs resource locator format:
  `{ __rl: true, value: 'ID', mode: 'id' }` (plain string fails).
- `ON CONFLICT DO UPDATE` is preferred over `DO NOTHING` when downstream
  filters use `fetched_at >= NOW() - INTERVAL 'X hours'` — `DO NOTHING`
  strands items outside the window.
- Always call `validate_workflow` before `update_workflow` / `create_workflow_from_code`.

## Py-helpers deployment notes

- Railway auto-deploys from the current branch (not `main`). Dockerfile uses
  shell-form `CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8787}` so
  Railway's `$PORT` gets expanded.
- Container currently ships only `/health`, `/scrape-article`,
  `/parse-google-trends`. Smaller image now that yt-dlp/youtube-transcript-api
  are gone.

## Open questions for the user

1. `frontierwatch` — what does it actually ingest and emit? Which Postgres
   table should its output land in? Any scheduling constraint?
2. For `newsletter-digest` migration — use existing `news_items` with a new
   `source_type='newsletter'`, or a new `newsletter_items` table?
3. Briefing email recipients — is it still just one address, or has the list
   grown? (Check `RECIPIENT_EMAIL` env from old GHA and confirm.)
4. Cutover timing for deprecating the old GHA workflow (`.github/workflows/fetch_youtube.yml`) — keep running in parallel for N days after generate-briefing is solid, or cut sooner?

## Quick start for next session

```bash
git checkout claude/run-briefing-script-7xbIt
git pull origin claude/run-briefing-script-7xbIt
```

Then: read this file, then `n8n/workflows/generate-briefing.ts` and
`scripts/generate_briefing.py`, and start on the briefing fine-tune.
