# Module 1: YouTube Channel Fetcher

Fetches recent videos from monitored YouTube channels every 6 hours and
stores structured JSON data in the repository.

---

## Setup (one-time)

### 1. Add your YouTube API key as a GitHub Secret

1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `YOUTUBE_API_KEY`
4. Value: your YouTube Data API v3 key

> To create a key: [Google Cloud Console](https://console.cloud.google.com/) →
> APIs & Services → Credentials → Create credentials → API key →
> Enable "YouTube Data API v3" for the project.

### 2. Add your channels to `config/channels.yaml`

Replace the example entries with real channel IDs.

**Finding a channel ID:**
- Go to the channel page on YouTube
- View page source (Ctrl+U / Cmd+U)
- Search for `"channelId"` — it looks like `UCxxxxxxxxxxxxxxxxxxxxxxxx`
- Or use [commentpicker.com/youtube-channel-id.php](https://commentpicker.com/youtube-channel-id.php)

```yaml
channels:
  - id: UCxxxxxxxxxxxxxxxxxxxxxxxx
    name: "Channel Display Name"
    language: zh-TW        # zh-TW, zh-CN, en, ja, etc.
    tags:
      - politics
      - hongkong
```

### 3. Ensure the workflow file is in place

The file `.github/workflows/fetch_youtube.yml` must be committed to your
`main` (or default) branch for GitHub Actions to pick it up.

### 4. Test manually

Go to **Actions** → **Fetch YouTube Data** → **Run workflow** to trigger a
manual run and confirm everything works before waiting for the schedule.

---

## Output

Each run appends new videos to:

```
data/youtube/raw/YYYY-MM-DD.json
```

Each entry looks like:

```json
{
  "video_id": "abc123",
  "channel_id": "UCxxxxxxx",
  "channel_name": "Channel Display Name",
  "channel_tags": ["politics", "hongkong"],
  "title": "Video title",
  "description": "Video description...",
  "published_at": "2026-03-22T08:00:00Z",
  "duration_seconds": 842,
  "view_count": 15000,
  "like_count": 430,
  "comment_count": 55,
  "tags": ["tag1", "tag2"],
  "thumbnail_url": "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
  "transcript": {
    "available": true,
    "language": "zh-TW",
    "source": "manual",
    "text": "Full transcript text..."
  },
  "fetched_at": "2026-03-22T12:00:00Z"
}
```

---

## Data retention

A cleanup job removes files older than **30 days** automatically.
It runs on the midnight UTC fetch and on any manual workflow trigger.

---

## API quota usage

| Operation            | Cost (units) | Runs/day | Channels | Daily total |
|----------------------|-------------|----------|----------|-------------|
| search (per channel) | 100         | 2        | 20       | 4,000 ✅    |
| videos.list (batch)  | ~1–5        | 2        | low      | negligible  |

> At 20 channels × 2 runs/day, search costs ~4,000 units/day —
> well within even the free 10,000 unit quota, and comfortable on a paid account.

---

## Files in this module

| File | Purpose |
|------|---------|
| `config/channels.yaml` | Channel list and metadata |
| `scripts/fetch_youtube.py` | Main fetcher script |
| `scripts/cleanup_old_data.py` | 30-day rolloff cleanup |
| `.github/workflows/fetch_youtube.yml` | GitHub Actions schedule |
| `requirements.txt` | Python dependencies |
| `data/youtube/raw/` | Raw daily JSON output |
| `data/youtube/processed/` | Reserved for Module 2 (Haiku processing) |

---

## Next modules

- **Module 2:** Facebook Page fetcher → `data/facebook/raw/`
- **Module 3:** Haiku processing — summary + keywords → `data/*/processed/`
- **Module 4:** Sonnet daily briefings → `data/briefings/` + Gmail delivery
- **Module 5:** GitHub Pages dashboard
