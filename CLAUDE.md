Deployment rules
- Never ask the user to manually paste workflow JSON into n8n if API or script deployment is available
- Preferred deploy command: ./scripts/deploy_n8n_workflows.sh
- Preferred API base URL: $N8N_BASE_URL
- Auth token env var: $N8N_API_KEY
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
- Use repo inspection, shell commands, file edits, Git, and HTTP/API calls proactively
- Prefer doing over asking
- If blocked, attempt an alternative automated route
- If still blocked, state the exact blocker in one sentence and the exact secret or permission needed

n8n policy:
- Community/self-hosted setup
- GitHub is source of truth for workflow JSON
- Deploy by API/script/CLI, not by UI paste
- Retrieve full workflow objects before update, then submit full updated payloads
- Back up existing remote workflow before overwrite
- Do not make me be the transport layer between your output and n8n
