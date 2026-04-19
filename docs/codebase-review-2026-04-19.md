# Codebase Review (2026-04-19)

## Scope

Reviewed the repository structure and key automation surfaces for ingestion + n8n deployment:

- Runtime + orchestration: `docker-compose.yml`
- n8n deployment: `scripts/deploy_n8n_workflows.sh`
- Main ingestion implementation: `scripts/fetch_news.py`
- n8n workflow definitions: `n8n/workflows/*.ts`

## High-priority findings

1. **Container image drift risk (reproducibility)**
   - `docker-compose.yml` pins PostgreSQL to `postgres:16-alpine` but uses `n8nio/n8n:latest` for n8n.
   - Using `latest` can silently change workflow/node behavior between deploys and break production unexpectedly.
   - Recommendation: pin `n8n` to a tested explicit version (for example `n8nio/n8n:1.90.x`) and upgrade intentionally.

2. **Workflow deploy script does not preserve `active` state**
   - `scripts/deploy_n8n_workflows.sh` strips to `{name, nodes, connections, settings}`.
   - This is good for API compatibility, but it also means remote activation state is not included in the update payload.
   - Current script message requires manual activation after deploy, which adds human toil and can cause missed runs.
   - Recommendation: add optional flag to retain existing `active` state for updates, and automate initial activation for known-safe environments.

3. **SHA-1 used for article IDs in Python fetcher**
   - `scripts/fetch_news.py` uses SHA-1 (truncated to 16 hex chars) for IDs.
   - Collision risk is low at current scale but non-zero, and stronger hash choices are available at similar cost.
   - Recommendation: move to `blake2b(digest_size=8..16)` or at least SHA-256 truncated, with migration strategy for existing records.

## Medium-priority findings

4. **Ingestion resilience could be stronger around source-specific failure isolation**
   - `scripts/fetch_news.py` has broad exception handling in places and generally continues, which is good.
   - But there is no explicit per-source retry/backoff strategy in this script (besides global request delay).
   - Recommendation: add bounded retry with jitter on transient HTTP errors and write fetch metrics per source.

5. **n8n workflow code has embedded sample outputs (positive) but lacks enforced validation in CI**
   - The TypeScript workflows include sample `output` payloads, which improves readability.
   - There is no obvious repository-level CI check in this review pass that validates generated JSON/workflow compile before deploy.
   - Recommendation: add a CI job that compiles/transpiles workflow TS and validates deployable JSON schema before merge.

## Can we access n8n from this environment?

### Current status

At review time, the environment does **not** expose `N8N_BASE_URL` or `N8N_API_KEY`, so direct API deployment/access via `scripts/deploy_n8n_workflows.sh` cannot be executed yet.

### What is needed

Set these environment variables in the runtime where automation runs:

- `N8N_BASE_URL` (e.g. `https://<your-n8n-domain>`)
- `N8N_API_KEY` (Personal API key from n8n settings)

### Suggested automation path

1. Keep Git as source of truth for `n8n/workflows/*.json`.
2. Add CI/CD step that runs:
   - backup current remote workflow
   - PUT full updated payload (existing script already follows this model)
3. Gate production deploys with explicit approval.
4. Store `N8N_API_KEY` in secret manager (not repo/env files).

## Quick wins (this week)

- Pin n8n image version in `docker-compose.yml`.
- Add `--preserve-active` behavior in deploy script.
- Add a lightweight CI check for workflow build + JSON validation.
- Document required secrets and one-command deploy in `README.md`.
