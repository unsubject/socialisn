"""
fetch_youtube.py
Module 1: YouTube Channel Fetcher

Fetches videos published in the last 24 hours from all channels listed in
config/channels.yaml. For each video, retrieves full metadata and attempts
to fetch a transcript (prefers manual captions; prefers Traditional Chinese,
falls back to English, then any available language).

Output: data/youtube/raw/YYYY-MM-DD.json  (appends; deduplicates by video_id)

Run:    python scripts/fetch_youtube.py
Env:    YOUTUBE_API_KEY  — YouTube Data API v3 key (set as GitHub Secret)
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
import yaml
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "channels.yaml"
RAW_DATA_DIR = REPO_ROOT / "data" / "youtube" / "raw"
LOOKBACK_HOURS = 24
YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"

# Transcript language preference order
TRANSCRIPT_LANG_PREFERENCE = ["zh-TW", "zh-Hant", "zh", "en"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers — YouTube Data API v3
# ---------------------------------------------------------------------------

def get_api_key() -> str:
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        log.error("YOUTUBE_API_KEY environment variable is not set.")
        sys.exit(1)
    return key


def load_channels() -> list[dict]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
    channels = config.get("channels", [])
    log.info(f"Loaded {len(channels)} channels from config.")
    return channels


def search_recent_videos(channel_id: str, api_key: str, published_after: str) -> list[str]:
    """Return list of video IDs published after published_after (ISO 8601 string)."""
    url = f"{YOUTUBE_API_BASE}/search"
    params = {
        "key": api_key,
        "channelId": channel_id,
        "part": "id",
        "type": "video",
        "order": "date",
        "publishedAfter": published_after,
        "maxResults": 50,
    }
    video_ids = []
    while True:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        for item in data.get("items", []):
            video_ids.append(item["id"]["videoId"])
        next_page = data.get("nextPageToken")
        if not next_page:
            break
        params["pageToken"] = next_page
    return video_ids


def fetch_video_metadata(video_ids: list[str], api_key: str) -> list[dict]:
    """Fetch full metadata for up to 50 video IDs in one API call."""
    if not video_ids:
        return []
    url = f"{YOUTUBE_API_BASE}/videos"
    params = {
        "key": api_key,
        "id": ",".join(video_ids),
        "part": "snippet,contentDetails,statistics",
    }
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json().get("items", [])


def parse_duration(iso_duration: str) -> int:
    """Convert ISO 8601 duration (PT1H2M3S) to total seconds."""
    import re
    match = re.match(
        r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_duration
    )
    if not match:
        return 0
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    return hours * 3600 + minutes * 60 + seconds


# ---------------------------------------------------------------------------
# Helpers — Transcripts
# ---------------------------------------------------------------------------

def fetch_transcript(video_id: str, channel_language: str) -> dict:
    """
    Attempt to fetch a transcript for the given video.
    Preference order:
      1. Manual captions in preferred languages
      2. Auto-generated captions in preferred languages
      3. Any available transcript
    Returns a dict with keys: available, language, source, text
    """
    null_result = {"available": False, "language": None, "source": None, "text": None}

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
    except (TranscriptsDisabled, VideoUnavailable):
        return null_result
    except Exception as e:
        log.warning(f"  Transcript list error for {video_id}: {e}")
        return null_result

    # Build preference list: channel language first, then defaults
    lang_pref = list(dict.fromkeys([channel_language] + TRANSCRIPT_LANG_PREFERENCE))

    # 1. Try manual captions in preferred languages
    for lang in lang_pref:
        try:
            transcript = transcript_list.find_manually_created_transcript([lang])
            entries = transcript.fetch()
            return {
                "available": True,
                "language": transcript.language_code,
                "source": "manual",
                "text": " ".join(e["text"] for e in entries).strip(),
            }
        except NoTranscriptFound:
            continue

    # 2. Try auto-generated captions in preferred languages
    for lang in lang_pref:
        try:
            transcript = transcript_list.find_generated_transcript([lang])
            entries = transcript.fetch()
            return {
                "available": True,
                "language": transcript.language_code,
                "source": "auto",
                "text": " ".join(e["text"] for e in entries).strip(),
            }
        except NoTranscriptFound:
            continue

    # 3. Fall back to any available transcript
    try:
        all_transcripts = list(transcript_list)
        if all_transcripts:
            transcript = all_transcripts[0]
            entries = transcript.fetch()
            return {
                "available": True,
                "language": transcript.language_code,
                "source": "manual" if not transcript.is_generated else "auto",
                "text": " ".join(e["text"] for e in entries).strip(),
            }
    except Exception as e:
        log.warning(f"  Fallback transcript error for {video_id}: {e}")

    return null_result


# ---------------------------------------------------------------------------
# Data persistence
# ---------------------------------------------------------------------------

def load_existing_records(date_str: str) -> dict[str, dict]:
    """Load today's existing records, keyed by video_id."""
    path = RAW_DATA_DIR / f"{date_str}.json"
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        records = json.load(f)
    return {r["video_id"]: r for r in records}


def save_records(date_str: str, records: dict[str, dict]) -> None:
    RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DATA_DIR / f"{date_str}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(list(records.values()), f, ensure_ascii=False, indent=2)
    log.info(f"Saved {len(records)} records to {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    api_key = get_api_key()
    channels = load_channels()

    now_utc = datetime.now(timezone.utc)
    published_after = (now_utc - timedelta(hours=LOOKBACK_HOURS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    date_str = now_utc.strftime("%Y-%m-%d")
    fetched_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    log.info(f"Fetching videos published after {published_after}")

    # Load existing records for today to support deduplication
    existing = load_existing_records(date_str)
    new_count = 0

    for channel in channels:
        channel_id = channel["id"]
        channel_name = channel.get("name", channel_id)
        channel_language = channel.get("language", "en")
        channel_tags = channel.get("tags", [])

        log.info(f"Processing channel: {channel_name} ({channel_id})")

        try:
            video_ids = search_recent_videos(channel_id, api_key, published_after)
        except Exception as e:
            log.error(f"  Search failed for {channel_id}: {e}")
            continue

        if not video_ids:
            log.info(f"  No new videos found.")
            continue

        log.info(f"  Found {len(video_ids)} video(s). Fetching metadata...")

        # Fetch metadata in batches of 50 (API max)
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i:i + 50]
            try:
                items = fetch_video_metadata(batch, api_key)
            except Exception as e:
                log.error(f"  Metadata fetch failed for batch: {e}")
                continue

            for item in items:
                video_id = item["id"]

                # Skip if already stored
                if video_id in existing:
                    log.info(f"  Skipping duplicate: {video_id}")
                    continue

                snippet = item.get("snippet", {})
                details = item.get("contentDetails", {})
                stats = item.get("statistics", {})

                log.info(f"  Fetching transcript for: {video_id}")
                transcript = fetch_transcript(video_id, channel_language)

                record = {
                    "video_id": video_id,
                    "channel_id": channel_id,
                    "channel_name": channel_name,
                    "channel_tags": channel_tags,
                    "title": snippet.get("title", ""),
                    "description": snippet.get("description", ""),
                    "published_at": snippet.get("publishedAt", ""),
                    "duration_seconds": parse_duration(
                        details.get("duration", "PT0S")
                    ),
                    "view_count": int(stats.get("viewCount", 0)),
                    "like_count": int(stats.get("likeCount", 0)),
                    "comment_count": int(stats.get("commentCount", 0)),
                    "tags": snippet.get("tags", []),
                    "thumbnail_url": (
                        snippet.get("thumbnails", {})
                        .get("high", {})
                        .get("url", "")
                    ),
                    "transcript": transcript,
                    "fetched_at": fetched_at,
                }

                existing[video_id] = record
                new_count += 1

    save_records(date_str, existing)
    log.info(f"Done. {new_count} new video(s) added.")


if __name__ == "__main__":
    main()
