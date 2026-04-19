# N8N_MCP_SETUP — connecting Claude to this n8n instance

**Read this at session start. If `mcp__n8n__*` tools are not loaded, set them up before doing any n8n work.**

## 0. Verify whether n8n MCP is already loaded

Run `ToolSearch` with query `n8n`. If results come back (e.g. `mcp__n8n__list_workflows`), you're connected — skip to §3. If nothing matches, continue with §1.

## 1. Get the connection details from the n8n instance

The user's n8n is at `https://n8n.srv1565522.hstgr.cloud`. Ask the user to:

1. Open `Settings → MCP` in the n8n UI (the page titled "Instance-level MCP")
2. Confirm the **Enabled** toggle is on
3. Click **Connection details**
4. Copy two values: the **server URL** (something like `https://n8n.srv1565522.hstgr.cloud/mcp/sse` or `…/api/v1/mcp`) and the **bearer token / API key**
5. Make sure the workflows you want exposed appear in the **Workflows** tab and are toggled on (button: **Enable workflows**)

Do **not** ask the user to paste the token in chat. Have them put it in an env var (`N8N_MCP_TOKEN`) and reference it from config.

## 2. Add the server to Claude Code's MCP config

Pick the variant that matches the runtime:

### Claude Code CLI / desktop

`~/.claude/settings.json` (user scope) **or** project `.mcp.json`:

```json
{
  "mcpServers": {
    "n8n": {
      "type": "sse",
      "url": "https://n8n.srv1565522.hstgr.cloud/mcp/sse",
      "headers": {
        "Authorization": "Bearer ${N8N_MCP_TOKEN}"
      }
    }
  }
}
```

If the connection details page shows a streamable-HTTP endpoint instead of SSE, use `"type": "http"` with the same shape.

Equivalent CLI one-liner:
```bash
claude mcp add --transport sse n8n https://n8n.srv1565522.hstgr.cloud/mcp/sse \
  --header "Authorization: Bearer $N8N_MCP_TOKEN"
```

After editing settings.json, restart the Claude Code session for the new MCP server to load.

### Claude Code on the web

The web harness loads MCP servers from the JSON file passed via `--mcp-config` at launch (visible in the session's bash env as `--mcp-config /tmp/mcp-config-<session>.json`). Adding a server here is a harness/admin operation — not editable from inside an active session.

**Tell the user**: in the Claude Code web settings (or wherever the session config lives for the web variant), add the n8n entry above to the project's MCP server list, then start a fresh session.

## 3. Confirm it's working

Once connected, these tools should appear (names from prior sessions):

- `mcp__n8n__list_workflows`
- `mcp__n8n__get_workflow`
- `mcp__n8n__create_workflow_from_code`
- `mcp__n8n__update_workflow`
- `mcp__n8n__validate_workflow`
- `mcp__n8n__execute_workflow`
- `mcp__n8n__activate_workflow` / `mcp__n8n__deactivate_workflow`

(Exact set depends on n8n version and which workflows are exposed.)

Quick health check at session start:

```
ToolSearch query="n8n" → expect ≥1 result
mcp__n8n__list_workflows → expect a JSON array of the user's workflows
```

## 4. Operating model — git as source of truth

Once MCP is live, the loop is:

1. Edit JSON under `n8n/workflows/*.json` on a feature branch
2. `mcp__n8n__validate_workflow` against the new JSON
3. Look up by name with `mcp__n8n__list_workflows`; if it exists call `mcp__n8n__update_workflow`, otherwise `mcp__n8n__create_workflow_from_code`
4. Optionally `mcp__n8n__execute_workflow` for a smoke test
5. Commit, push, open PR, merge

**Never** ask the user to copy-paste JSON into the n8n UI. **Never** build a CI pipeline that hits n8n's REST API from GitHub-hosted runners — those IPs are blocked at Hostinger's network edge (verified 2026-04-19, see HANDOFF.md). MCP bypasses that because it tunnels through the user's authenticated MCP client.

## 5. Credentials still belong in the n8n UI

n8n credentials (Gmail OAuth2, Postgres, Anthropic API Key, etc.) are encrypted against the instance's encryption key and intentionally don't sync over MCP or git. Binding a credential to a node is a one-time UI action per credential. Workflow JSON references credentials by id/name only.

## 6. If MCP can't be made to work

Fallback (in priority order):
1. Ask the user to manually export from n8n UI (Workflows → ⋮ → Download) and paste into git — slow, error-prone.
2. SSH-based deploy — runs `n8n import:workflow` inside the Docker container. Requires `SSH_HOST`, `SSH_USER`, `SSH_KEY` secrets and SSH ingress to the VPS. See `HANDOFF.md` for why this was deferred.
3. Self-hosted GitHub Actions runner on the same VPS — heavier ops.

MCP is the right answer. Exhaust §1–§3 troubleshooting before falling back.
