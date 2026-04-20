# Google Tasks setup for socialisn-studio

One-time configuration so `check_parking_lot` can read your "Subjects" Google Tasks list and `list_daily_candidates` can flag subjects you’ve parked.

## 1. Create an OAuth client in Google Cloud Console

1. Go to <https://console.cloud.google.com/>. Use any project, or create one ("socialisn-studio" is fine).
2. **APIs & Services → Library** → search "Tasks API" → **Enable**.
3. **APIs & Services → OAuth consent screen** → pick **External** user type (unless you have a Workspace). Fill in app name ("socialisn-studio"), support email, developer email. On the **Scopes** step, add `.../auth/tasks`. On the **Test users** step, add your own Gmail address. Save.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type: **Desktop app**. Name: "socialisn-studio CLI". Create. You’ll get a **Client ID** and **Client Secret**.

## 2. Run the one-time auth script

You’ll run this locally once to capture a long-lived refresh token. Node 20+ required.

Option A — from a cloned repo:

```bash
STUDIO_GOOGLE_CLIENT_ID=<your-id> \
STUDIO_GOOGLE_CLIENT_SECRET=<your-secret> \
  node scripts/google-auth.mjs
```

Option B — without cloning:

```bash
curl -sSL -o /tmp/google-auth.mjs https://raw.githubusercontent.com/unsubject/socialisn/main/scripts/google-auth.mjs
STUDIO_GOOGLE_CLIENT_ID=<your-id> \
STUDIO_GOOGLE_CLIENT_SECRET=<your-secret> \
  node /tmp/google-auth.mjs
```

The script opens your browser to Google’s consent screen. Sign in with the same Google account that owns the "Subjects" Tasks list (the one you’re a Test user on). Approve the `Tasks` scope. The browser redirects back to `localhost:7777`, and the script prints:

```
=== REFRESH TOKEN ===
1//0abcdefg...
```

Copy that refresh token.

### If it says "No refresh_token returned"

Google only issues a refresh token on **first consent**. If you’ve previously granted this app access, revoke it at <https://myaccount.google.com/permissions> and re-run the script.

## 3. Add env vars to Railway

In Railway → studio service → Variables, add:

- `STUDIO_GOOGLE_CLIENT_ID` — from step 1
- `STUDIO_GOOGLE_CLIENT_SECRET` — from step 1
- `STUDIO_GOOGLE_REFRESH_TOKEN` — from step 2
- `STUDIO_GOOGLE_TASKS_LIST_NAME` — *optional*, defaults to `Subjects`. Override if your parking-lot list has a different name.
- `STUDIO_GOOGLE_TASKS_LIST_ID` — *optional*. If set, skips the name-to-ID lookup on every call. Find the ID via `curl -H "Authorization: Bearer <access_token>" https://tasks.googleapis.com/tasks/v1/users/@me/lists` once.

Save. Railway redeploys automatically.

## 4. Verify

From Claude Desktop:

> "Call check_parking_lot with window_hours 168."

Expected: JSON with `task_count`, `by_classification` counts, and a `tasks` array where each task has a `classification` (`ripe_now` / `ripe_soon` / `cold` / `stale`), `audience_fit`, `momentum` block, and `first_seen_at`.

If you get `error: google_tasks_not_configured`, the env vars didn’t take effect — check Railway.

If you get `error: list_not_found`, the list name doesn’t match. Either rename your Google Tasks list to `Subjects` or set `STUDIO_GOOGLE_TASKS_LIST_NAME`.

If you get `google_tasks_api_error` with `invalid_grant`, your refresh token was revoked (e.g. by the 7-day test-user policy on unverified apps, or because you’ve changed your Google password). Re-run `scripts/google-auth.mjs` and update the env var.

## Notes on the test-user limit

Unverified OAuth apps on Google cap refresh tokens at 7 days of validity for external users. Two ways around it for a personal system:

- **Simplest**: just re-run the auth script weekly. Low friction.
- **Better**: submit the OAuth consent screen for **verification** (Google reviews it, takes a few business days for `tasks` scope). Once verified, refresh tokens don’t expire unless revoked.
- **Best for single-user**: in the OAuth consent screen, publish the app with **publishing status = In production** but keep **user type = External**. Google won’t require verification for a single Test user of `tasks` scope — confirm in your console.

Pick whichever matches your tolerance for occasional re-auth.
