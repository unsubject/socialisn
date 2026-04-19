# socialisn

Monitoring Hong Kong public discourse with automated ingestion and briefing workflows.

## Deploy n8n workflows (preferred: MCP from Claude Code)

The repo ships `.mcp.json` wired to n8n's instance-level MCP server via env-var interpolation on `N8N_MCP_URL` and `N8N_MCP_TOKEN`. How you provide those depends on where Claude Code runs.

**Claude Code on the web (claude.ai/code):** add the two values as repository environment variables/secrets in the Claude Code web settings for this repo. They'll be injected into every new session's environment. Start a fresh session after adding them — MCP servers register at session start only.

**Claude Code locally:** export the vars in your shell before launching:

```bash
export N8N_MCP_URL="https://n8n.example.com/mcp/<connection-path-from-UI>"
export N8N_MCP_TOKEN="<personal MCP Access Token>"
claude
```

Both values come from the n8n UI: `Settings → MCP → Connection details → Access Token` tab. The token is an **MCP Access Token**, separate from the regular n8n REST API key used by the fallback script below.

Verify inside Claude Code: `mcp__n8n__*` tools (e.g. `mcp__n8n__list_workflows`) should be callable.

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
