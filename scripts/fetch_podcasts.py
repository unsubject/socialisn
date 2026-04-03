"""
fetch_podcasts.py
Module 2c: Podcast Fetcher

Reads podcast list from config/podcasts.yaml, resolves each Apple Podcast ID
to an RSS feed URL via the iTunes Lookup API, then fetches recent episodes
using feedparser.

Deduplicates by episode GUID within the daily file.
Output: data/podcasts/raw/YYYY-MM-DD.json  (appends; deduplicates by episode_id)

Run:    python scripts/fetch_podcasts.py
"""

import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

import feedparser
import requests
import yaml

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "podcasts.yaml"
RAW_DATA_DIR = REPO_ROOT / "data" / "podcasts" / "raw"
LOOKBACK_HOURS = 72  # Podcasts publish less frequently; wider window

ITUNES_LOOKUP_URL = "https://itunes.apple.com/lookup"

# Seconds between requests
REQUEST_DELAY = 1.0

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; IntelligenceMonitorBot/1.0; "
        "+https://github.com)"
    )
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_episode_id(guid: str) -> str:
    """Stable ID from episode GUID — SHA1 hex, first 16 chars."""
    return hashlib.sha1(guid.encode()).hexdigest()[:16]


def load_config() -> list[dict]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
    podcasts = config.get("podcasts", [])
    log.info(f"Loaded {len(podcasts)} podcasts from config.")
    return podcasts


def resolve_feed_url(apple_id: int) -> str | None:
    """Resolve an Apple Podcast ID to an RSS feed URL via iTunes Lookup API."""
    try:
        resp = requests.get(
            ITUNES_LOOKUP_URL,
            params={"id": apple_id, "entity": "podcast"},
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])
        if results:
            feed_url = results[0].get("feedUrl")
            if feed_url:
                return feed_url
            log.warning(f"  No feedUrl in iTunes result for ID {apple_id}")
        else:
            log.warning(f"  No results from iTunes for ID {apple_id}")
    except Exception as e:
        log.error(f"  iTunes lookup failed for ID {apple_id}: {e}")
    return None


def parse_duration(duration_str: str | None) -> int | None:
    """Parse podcast duration string (HH:MM:SS or MM:SS or seconds) to seconds."""
    if not duration_str:
        return None
    # Pure number = seconds
    if duration_str.isdigit():
        return int(duration_str)
    # HH:MM:SS or MM:SS
    parts = duration_str.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        pass
    return None


def clean_html(text: str) -> str:
    """Strip HTML tags from text."""
    if not text:
        return ""
    from bs4 import BeautifulSoup
    return BeautifulSoup(text, "html.parser").get_text(separator=" ", strip=True)


def is_within_lookback(published_at: str | None, lookback_hours: int) -> bool:
    """Return True if published_at is within the lookback window."""
    if not published_at:
        return True
    try:
        try:
            pub = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
        except ValueError:
            pub = parsedate_to_datetime(published_at)
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
        return pub >= cutoff
    except Exception:
        return True


# ---------------------------------------------------------------------------
# Episode fetching
# ---------------------------------------------------------------------------

def fetch_podcast_episodes(podcast: dict, feed_url: str, fetched_at: str) -> list[dict]:
    """Fetch recent episodes from a podcast RSS feed."""
    name = podcast["name"]
    apple_id = podcast["apple_id"]
    language = podcast.get("language", "en")
    tags = podcast.get("tags", [])

    log.info(f"  Parsing feed for {name}: {feed_url}")

    try:
        feed = feedparser.parse(feed_url)
    except Exception as e:
        log.error(f"  Feed parse failed for {name}: {e}")
        return []

    if feed.bozo and not feed.entries:
        log.warning(f"  Feed malformed or empty: {name}")
        return []

    # Extract podcast-level metadata
    podcast_author = feed.feed.get("author", feed.feed.get("itunes_author", ""))
    podcast_image = ""
    if hasattr(feed.feed, "image") and feed.feed.image:
        podcast_image = getattr(feed.feed.image, "href", "")
    if not podcast_image:
        # Try iTunes image
        itunes_image = feed.feed.get("itunes_image", {})
        if isinstance(itunes_image, dict):
            podcast_image = itunes_image.get("href", "")

    records = []
    for entry in feed.entries:
        # Parse published date
        published_at = None
        for date_field in ("published", "updated", "created"):
            raw_date = entry.get(date_field)
            if raw_date:
                published_at = raw_date
                break

        if not is_within_lookback(published_at, LOOKBACK_HOURS):
            continue

        # Episode GUID
        guid = entry.get("id", entry.get("guid", entry.get("link", "")))
        if not guid:
            continue

        title = entry.get("title", "").strip()
        description = entry.get("summary", entry.get("subtitle", "")).strip()
        description = clean_html(description)
        if len(description) > 3000:
            description = description[:3000] + "..."

        # Episode link
        episode_url = entry.get("link", "")

        # Audio enclosure
        audio_url = ""
        audio_length = None
        for enc in entry.get("enclosures", []):
            if enc.get("type", "").startswith("audio/"):
                audio_url = enc.get("href", enc.get("url", ""))
                try:
                    audio_length = int(enc.get("length", 0))
                except (ValueError, TypeError):
                    audio_length = None
                break

        # Duration
        duration_str = entry.get("itunes_duration", None)
        duration_seconds = parse_duration(duration_str)

        # Episode number / season
        episode_num = entry.get("itunes_episode", None)
        season_num = entry.get("itunes_season", None)

        record = {
            "episode_id": make_episode_id(guid),
            "podcast_name": name,
            "podcast_apple_id": apple_id,
            "podcast_author": podcast_author,
            "podcast_image": podcast_image,
            "title": title,
            "description": description,
            "published_at": published_at,
            "duration_seconds": duration_seconds,
            "episode_url": episode_url,
            "audio_url": audio_url,
            "audio_length_bytes": audio_length,
            "episode_number": episode_num,
            "season_number": season_num,
            "fetched_at": fetched_at,
            "language": language,
            "tags": tags,
        }
        records.append(record)

    log.info(f"  Found {len(records)} episode(s) within lookback window for {name}.")
    return records


# ---------------------------------------------------------------------------
# Data persistence
# ---------------------------------------------------------------------------

def load_existing_records(date_str: str) -> dict[str, dict]:
    path = RAW_DATA_DIR / f"{date_str}.json"
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        records = json.load(f)
    return {r["episode_id"]: r for r in records}


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
    podcasts = load_config()

    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")
    fetched_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    existing = load_existing_records(date_str)
    new_count = 0

    for podcast in podcasts:
        name = podcast["name"]
        apple_id = podcast["apple_id"]

        log.info(f"Processing: {name} (ID: {apple_id})")

        # Resolve RSS feed URL
        feed_url = resolve_feed_url(apple_id)
        if not feed_url:
            log.warning(f"  Skipping {name}: could not resolve feed URL.")
            continue

        log.info(f"  Resolved feed URL: {feed_url}")
        time.sleep(REQUEST_DELAY)

        # Fetch episodes
        episodes = fetch_podcast_episodes(podcast, feed_url, fetched_at)

        for episode in episodes:
            eid = episode["episode_id"]
            if eid in existing:
                log.info(f"  Skipping duplicate: {episode['title'][:60]}")
                continue
            existing[eid] = episode
            new_count += 1

        time.sleep(REQUEST_DELAY)

    save_records(date_str, existing)
    log.info(f"Done. {new_count} new episode(s) added.")


if __name__ == "__main__":
    main()
