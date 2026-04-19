#!/usr/bin/env bash
# Deploy n8n workflow JSON from n8n/workflows/*.json to the live n8n instance.
# Fallback for when the n8n MCP isn't wired into the current session. Prefer MCP.
#
# Requires:
#   N8N_BASE_URL  e.g. https://n8n.srv1565522.hstgr.cloud
#   N8N_API_KEY   Settings > n8n API > personal API key
#
# Options:
#   --dry-run             Print what would change, don't PUT/POST
#   --file <path>         Deploy a single file instead of the whole directory
#   --no-backup           Skip writing remote JSON to /tmp/n8n-backup-*.json
#   --no-preserve-active  Do not carry forward remote workflow active state
#
# Workflow:
#   1. GET the current workflow list.
#   2. For each local JSON, back up the remote copy (if any) to /tmp.
#   3. Strip n8n-rejected keys (id, tags, versionId, meta, pinData, triggerCount, createdAt, updatedAt, shared).
#   4. Preserve remote active state on PUT by default.
#   5. PUT if matched by name, POST if new.

set -euo pipefail

: "${N8N_BASE_URL:?N8N_BASE_URL is not set}"
: "${N8N_API_KEY:?N8N_API_KEY is not set}"

dry_run=0
backup=1
preserve_active=1
only_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --no-backup) backup=0; shift ;;
    --no-preserve-active) preserve_active=0; shift ;;
    --file) only_file="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

base="${N8N_BASE_URL%/}"
auth=(-H "X-N8N-API-KEY: $N8N_API_KEY" -H "Accept: application/json")

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }

strip_keys='{name, nodes, connections, settings: (.settings // {})}'

echo ">> Fetching remote workflow index"
remote=$(curl -fsS "${auth[@]}" "$base/api/v1/workflows?limit=250")

if [[ -n "$only_file" ]]; then
  files=("$only_file")
else
  shopt -s nullglob
  files=(n8n/workflows/*.json)
fi

[[ ${#files[@]} -gt 0 ]] || { echo "no workflow files found"; exit 1; }

ts=$(date -u +%Y%m%dT%H%M%SZ)

for f in "${files[@]}"; do
  name=$(jq -r '.name' "$f")
  echo ">> $f  (name=\"$name\")"

  id=$(jq -r --arg n "$name" '.data[] | select(.name == $n) | .id' <<<"$remote" | head -n1)
  payload=$(jq "$strip_keys" "$f")

  if [[ -n "$id" && "$id" != "null" ]]; then
    remote_full=""
    if [[ $backup -eq 1 || $preserve_active -eq 1 ]]; then
      remote_full=$(curl -fsS "${auth[@]}" "$base/api/v1/workflows/$id")
    fi

    if [[ $backup -eq 1 ]]; then
      bak="/tmp/n8n-backup-${name// /_}-${id}-${ts}.json"
      printf '%s\n' "$remote_full" > "$bak"
      echo "   backed up remote  -> $bak"
    fi

    if [[ $preserve_active -eq 1 ]]; then
      active=$(jq -r '.active // false' <<<"$remote_full")
      payload=$(jq --argjson active "$active" '. + {active: $active}' <<<"$payload")
      echo "   preserve active   -> $active"
    fi

    if [[ $dry_run -eq 1 ]]; then
      echo "   DRY-RUN would PUT  -> $base/api/v1/workflows/$id"
      continue
    fi

    code=$(curl -sS -o /tmp/n8n-resp.json -w "%{http_code}" \
      -X PUT "${auth[@]}" -H "Content-Type: application/json" \
      --data "$payload" "$base/api/v1/workflows/$id")
    action="PUT  id=$id"
  else
    if [[ $dry_run -eq 1 ]]; then
      echo "   DRY-RUN would POST -> $base/api/v1/workflows"
      continue
    fi

    code=$(curl -sS -o /tmp/n8n-resp.json -w "%{http_code}" \
      -X POST "${auth[@]}" -H "Content-Type: application/json" \
      --data "$payload" "$base/api/v1/workflows")
    action="POST (new)"
  fi

  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "   FAIL $action ($code):"
    cat /tmp/n8n-resp.json
    exit 1
  fi
  echo "   OK   $action ($code)"
done

echo ">> Done. Workflows are deployed; ensure credentials are bound in n8n if this is first deploy."
