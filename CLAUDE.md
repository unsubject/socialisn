# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

socialisn monitors Hong Kong public discourse via scheduled fetchers (YouTube, RSS news, podcasts, Gmail subscriptions, Perplexity) → Claude Haiku enrichment → Postgres → daily briefings. The active pipeline runs as n8n workflows on a self-hosted instance; Python scripts under `scripts/` are the legacy path being migrated to n8n.

## Architecture

- **Hostinger VPS** (`n8n.srv1565522.hstgr.cloud`): n8n (self-hosted, MCP-enabled) + Postgres (n8n DB and app DB in one instance).
- **GitHub (`unsubject/socialisn`)**: source of truth for `n8n/workflows/*.json`, `infra/init.sql`, `config/*.yaml`, legacy `scripts/*.py`.
- **Claude Code session**: GitHub MCP (scoped to this repo) + n8n MCP (configured via `.mcp.json` + `N8N_MCP_URL`/`N8N_MCP_TOKEN` env vars).
- **GitHub Pages** (`docs/`): static dashboard + RSS feeds (`feed.xml`, `youtube-feed.xml`, `podcast-feed.xml`, `topics-feed.xml`).

GitHub Actions cannot reach the n8n host (blocked at Hostinger edge from GH runners) — do not add Actions that push to n8n. Use n8n MCP from Claude Code, or the local `scripts/deploy_n8n_workflows.sh` fallback.

## Deploying n8n workflows

Preferred: n8n MCP tools (`mcp__n8n__create_workflow_from_code`, `mcp__n8n__update_workflow`). Always call `mcp__n8n__validate_workflow` first. If `mcp__n8n__*` tools aren't loaded in a session, the MCP env vars are missing — see README.

Fallback (only if MCP is unavailable): `scripts/deploy_n8n_workflows.sh` with `N8N_BASE_URL` + `N8N_API_KEY` set (plain REST, separate from the MCP Access Token). Supports `--dry-run` and `--file <path>`.

## Database

Schema in `infra/init.sql`; source seeds in `infra/seed_sources.sql`. Key tables:
- `sources` — fetcher config
- `youtube_items`, `news_items`, `podcast_items`, `newsletter_items` — raw fetched items
- `item_enrichment(item_type, item_id, summary_zh, keywords_zh[], processed_at)` — 1:1 enrichment (newsletter items use the inline `newsletter_items.summary` column instead)
- `briefings(date, slot, markdown, html, email_sent_at, ...)`

## n8n SDK gotchas (stable invariants)

- `output: [{...}]` in `@n8n/workflow-sdk` node definitions is editor sample data, not runtime pinned data.
- `runOnceForEachItem` Code nodes return a single `{json: {...}}`; `runOnceForAllItems` uses `$input.all()` / `$("NodeName").all()` with `pairedItem: { item: k }`.
- `executeWorkflow` node's `workflowId` needs resource locator format: `{ __rl: true, value: 'ID', mode: 'id' }`.
- Prefer `ON CONFLICT DO UPDATE` over `DO NOTHING` when downstream filters use `fetched_at >= NOW() - INTERVAL 'X hours'` — `DO NOTHING` strands items outside the window.

## Credentials live in n8n, not git

One-time UI binding per workflow: `Postgres`, `Anthropic API Key` (HTTP Header Auth, `x-api-key`), `Gmail OAuth2` (needs `gmail.modify` scope for trash steps), `YouTube API Key` (httpQueryAuth, Name=`key`), `Perplexity API` (Bearer).

## Session handoff

`HANDOFF.md` holds the most recent session's in-flight state (pending deploys, known-broken workflows, open questions). Read it at session start; update or rewrite it at session end.

## Deployment rules
- Never ask the user to manually paste workflow JSON into n8n if API or script deployment is available
- Always back up remote workflow JSON before update
- Always retrieve current workflow first, patch locally, then PUT full payload
- Production deploys require explicit confirmation; non-production deploys do not

Success condition:
- the required workflow/script change is completed in files
- the change is deployed to n8n automatically
- manual copy/paste is avoided

Failure condition:
- you mainly provide instructions for me to perform manually
- you stop after editing local files without attempting deployment
- you ask me to paste workflow JSON into the n8n UI without first exhausting automated options

Execution policy:
- Prefer doing over asking
- If blocked, attempt an alternative automated route
- If still blocked, state the exact blocker in one sentence and the exact secret or permission needed

n8n policy:
- Community/self-hosted setup
- GitHub is source of truth for workflow JSON
- Retrieve full workflow objects before update, then submit full updated payloads
- Back up existing remote workflow before overwrite
- Do not make me be the transport layer between your output and n8n
