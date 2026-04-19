# socialisn

Monitoring Hong Kong public discourse with automated ingestion and briefing workflows.

## Deploy n8n workflows (preferred: MCP from Claude Code)

The repo ships `.mcp.json` wired to n8n's instance-level MCP server. Before launching Claude Code from this directory, export the two values from the n8n UI (`Settings → MCP → Connection details → Access Token` tab):

```bash
export N8N_MCP_URL="https://n8n.example.com/mcp/<connection-path-from-UI>"
export N8N_MCP_TOKEN="<personal MCP Access Token>"
claude  # or `claude code`, depending on your install
```

Inside Claude Code, verify the server loaded: `mcp__n8n__*` tools should be callable. If not, restart Claude Code after exporting the vars — MCP servers register at session start only.

See n8n's docs: <https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/>.

## Deploy n8n workflows (fallback: REST API script)

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
