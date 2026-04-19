# Handoff — socialisn migration to n8n

_Last updated: 2026-04-19._

## TL;DR

Migrating socialisn from GitHub Actions to n8n (self-hosted on Railway) +
Postgres. Fetchers + enrichment are done; briefing email + dashboard still
need work. Also absorbing `unsubject/frontierwatch` and
`unsubject/newsletter-digest` into this pipeline.

Working branch: `claude/run-briefing-script-7xbIt`

---

## ⚠ CRITICAL: How to work with n8n workflows

### n8n MCP tools — use them directly

You have MCP tools connected to the live n8n instance. **Use them for all
workflow reads and writes.** Never ask the user to copy-paste workflow JSON
or act as a transport layer.

The MCP tool prefix is: `mcp__acc1563a-8fd7-48fa-b108-0ec47c0361bf__`

Key tools (use `ToolSearch` with `select:<name>` to load schemas before calling):

| Action | Tool |
|---|---|
| List workflows | `search_workflows` |
| Read a workflow | `get_workflow_details` |
| Validate code before updating | `validate_workflow` |
| Update an existing workflow | `update_workflow` |
| Create a new workflow | `create_workflow_from_code` |
| Run a workflow | `execute_workflow` |
| Check execution result | `get_execution` |
| Archive a workflow | `archive_workflow` |
| Look up node parameters | `search_nodes` → `get_node_types` |
| Get SDK syntax help | `get_sdk_reference` |

**Workflow sequence**: `search_nodes` → `get_node_types` → write code →
`validate_workflow` → `update_workflow` / `create_workflow_from_code`.

### n8n is the source of truth, NOT git

The user edits workflows directly in the n8n UI. The `.ts` files under
`n8n/workflows/` are **historical snapshots only** — they may be stale.

Rules:
- **To read current workflow state**: call `get_workflow_details` with the
  workflow ID. Do NOT read the `.ts` file and assume it's current.
- **To update a workflow**: call `update_workflow` directly. Do NOT
  push a `.ts` file and expect it to sync.
- **Only use git** for: py-helpers code, infra config (`init.sql`,
  `seed_sources.sql`, `Dockerfile`), and reference Python scripts.
- **If you need to save a workflow snapshot to git** for reference, do so
  AFTER reading the live state from n8n, not the other way around.

---

## Live n8n workflows

| Workflow | n8n ID | Active | Status |
|---|---|---|---|
| Fetch YouTube Videos | `x5s2rk7HWNQjX5N1` | ✅ | Done, tested |
| Fetch News (RSS) | `W2QHzmBjyUFs0xsd` | ✅ | Done, tested |
| Fetch Perplexity Search | `rkiWYmYBoVyi8Ih2` | ✅ | Done, tested |
| Fetch Podcasts | `Ykpcl95qtvzMv70b` | ✅ | Done, tested |
| Process Items with Haiku | `OG4iOnuMwxoJDbvK` | ✅ | Done, tested |
| Fetch Gmail Newsletters | `7ZlMNObjAMc26zoR` | ✅ | Done, tested |
| Generate Daily Briefing | `F0g69WDiNUX0OXNW` | ❌ | **Outstanding — needs fine-tuning** |
| Enrich YouTube Transcripts | `VuYc4FsgAxoDNMu7` | archived | Deprecated (YouTube IP-blocks Railway) |

Scratch workflows (ignore): `Kbar9Ajevy87MXqI`, `tOPMeTpBU30KnNRD`

---

## Outstanding work

### 1. Fine-tune `generate-briefing` (`F0g69WDiNUX0OXNW`)

Currently scaffolded but inactive. Needs:
- Prompt quality improvement (reference `scripts/generate_briefing.py` L149-199)
- Email HTML layout (Chinese typography: PingFang HK, Microsoft JhengHei, #d4a017 accent — see L267-321)
- Slot logic (morning 早報 / evening 晚報)
- Recipient config
- **Read the live workflow first** via `get_workflow_details("F0g69WDiNUX0OXNW")` — user may have edited it since last session.

### 2. Build `publish-dashboard`

Not yet created. Renders HTML + RSS from Postgres, pushes to `docs/*` via
GitHub API (GitHub Pages is the dashboard host). Reference Python:
`scripts/generate_dashboard.py`, `scripts/generate_rss.py`,
`scripts/generate_youtube_rss.py`, `scripts/generate_podcast_rss.py`,
`scripts/generate_topics_rss.py`.

### 3. Integrate sibling repos

- **`unsubject/frontierwatch`** — "Frontier Devs in Energy, IT, BioTech."
  Purpose still unknown — ask the user or clone the repo to read.
- **`unsubject/newsletter-digest`** — processes Gmail "Subscription" label
  via Claude Haiku → RSS. A `Fetch Gmail Newsletters` workflow
  (`7ZlMNObjAMc26zoR`) already exists and is active — this may already be
  partially migrated. Check its current state before building anything new.
- After migration, deprecate both repos from GitHub.

---

## Architecture

```
Railway:
  ├─ n8n (self-hosted)           — orchestration, all API calls, Anthropic/Gmail
  ├─ Postgres                    — n8n DB + app DB in one instance
  └─ py-helpers (FastAPI)        — /scrape-article, /parse-google-trends
                                   URL: https://socialisn-production.up.railway.app

GitHub (kept):
  └─ unsubject/socialisn         — configs, docs/ (GitHub Pages), this repo
```

## Database schema

Defined in `infra/init.sql`. Key tables:

- `sources(id, type, name, language, tags[], config JSONB, enabled)`
- `youtube_items`, `news_items`, `podcast_items` — raw fetched items
- `item_enrichment(item_type, item_id, summary_zh, keywords_zh[], processed_at)`
- `briefings(date, slot, markdown, html, email_sent_at, ...)` — UNIQUE(date, slot)

## n8n credentials

- `Postgres` — DB connection
- `Anthropic API Key` — Haiku + Sonnet (via HTTP node)
- `Anthropic` — LangChain node credential
- `Gmail OAuth2` — email send
- `YouTube API Key` — `httpQueryAuth` with Name=`key`
- `Perplexity API` — Bearer token

## n8n SDK gotchas

- `output: [{...}]` on nodes is **editor sample data only**, not runtime pins.
- `runOnceForEachItem` returns single `{json: {...}}`; `runOnceForAllItems`
  returns arrays via `$input.all()` / `$("NodeName").all()` with `pairedItem`.
- `executeWorkflow` node needs `workflowId: { __rl: true, value: 'ID', mode: 'id' }`.
- `ON CONFLICT DO UPDATE` preferred over `DO NOTHING` when downstream queries
  filter by `fetched_at`.
- Always `validate_workflow` before `update_workflow` / `create_workflow_from_code`.

## Deprecated: YouTube transcripts

YouTube returns 429 for Railway IPs. Both `youtube-transcript-api` and
`yt-dlp` fail. Archived workflow: `VuYc4FsgAxoDNMu7`. The `transcript_*`
columns in `youtube_items` remain but stay NULL. Do not resurrect without
an IP-blocking fix (cookies or residential proxy).

## Py-helpers

- Railway auto-deploys from `claude/run-briefing-script-7xbIt`
- Endpoints: `/health`, `/scrape-article`, `/parse-google-trends`
- Changes to `infra/py-helpers/` DO go through git (commit + push triggers deploy)
