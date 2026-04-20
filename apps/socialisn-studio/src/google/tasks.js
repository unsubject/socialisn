// Thin Google Tasks API client. Uses the personal OAuth refresh token
// flow: studio holds STUDIO_GOOGLE_REFRESH_TOKEN and exchanges it for a
// short-lived access token on demand (cached in memory until 60s before
// expiry). If the studio restarts, we re-exchange on first call.
//
// No DB persistence of access tokens — they're ephemeral and the refresh
// token is authoritative.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const TOKEN_TIMEOUT_MS = 15_000;
const TASKS_TIMEOUT_MS = 15_000;

let cachedToken = null;
let cachedExpiry = 0;

export function googleTasksConfigured() {
  return Boolean(
    process.env.STUDIO_GOOGLE_CLIENT_ID &&
    process.env.STUDIO_GOOGLE_CLIENT_SECRET &&
    process.env.STUDIO_GOOGLE_REFRESH_TOKEN
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.STUDIO_GOOGLE_CLIENT_ID,
    client_secret: process.env.STUDIO_GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.STUDIO_GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }, TOKEN_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`google token refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (Math.max(60, (data.expires_in || 3600) - 60)) * 1000;
  return cachedToken;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;
  return refreshAccessToken();
}

export async function findTasksListId(name = 'Subjects') {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(
    `${TASKS_API}/users/@me/lists?maxResults=100`,
    { headers: { Authorization: `Bearer ${token}` } },
    TASKS_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`google tasklists ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const list = (data.items || []).find((l) => l.title === name);
  return list ? list.id : null;
}

export async function listTasks(taskListId, { showCompleted = false } = {}) {
  const token = await getAccessToken();
  const url = `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks?maxResults=100&showCompleted=${showCompleted ? 'true' : 'false'}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    TASKS_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`google tasks.list ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.items || [];
}

// Reserved for step 7 (session-close mark-done). Exported here so the
// API surface lives in one file.
export async function markTaskCompleted(taskListId, taskId) {
  const token = await getAccessToken();
  const url = `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'completed' })
    },
    TASKS_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`google tasks.patch ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
