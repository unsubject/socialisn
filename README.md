# socialisn

Monitoring Hong Kong public discourse with automated ingestion and briefing workflows.

## Deploy n8n workflows (API)

This repo includes `scripts/deploy_n8n_workflows.sh` for safe workflow deployment.

### Required environment variables

- `N8N_BASE_URL` (for example: `https://n8n.example.com`)
- `N8N_API_KEY` (n8n personal API key)

### Usage

```bash
# preview changes without modifying remote
scripts/deploy_n8n_workflows.sh --dry-run

# deploy all JSON workflows under n8n/workflows/
scripts/deploy_n8n_workflows.sh

# deploy only one workflow file
scripts/deploy_n8n_workflows.sh --file n8n/workflows/fetch-gmail-newsletters.json
```

### Safety behavior

- Backs up remote workflow JSON to `/tmp/n8n-backup-*.json` before overwrite.
- Preserves remote workflow `active` state on updates by default.
- Uses full PUT payloads (name/nodes/connections/settings + active when updating).
