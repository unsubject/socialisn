"""
generate_youtube_rss.py
Module 5c: YouTube RSS Feed Generator

Reads processed YouTube data and generates an RSS 2.0 feed at
docs/youtube-feed.xml. Each video becomes one RSS entry with title,
channel name, summary, thumbnail, and link to the YouTube video.
Sorted newest first, capped at 100 entries from the last 7 days.

Run:    python scripts/generate_youtube_rss.py
"""

import json
import logging
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIR = REPO_ROOT / "data" / "youtube" / "processed"
DOCS_DIR = REPO_ROOT / "docs"
OUTPUT_PATH = DOCS_DIR / "youtube-feed.xml"
MAX_ENTRIES = 100
LOOKBACK_DAYS = 7

FEED_TITLE = "YouTube 頻道監察 Channel Monitor"
FEED_DESCRIPTION = "香港及國際 YouTube 頻道最新影片，自動監察更新"
FEED_LANGUAGE = "zh-TW"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_base_url() -> str:
    """Try to read GitHub Pages URL from environment, fall back to placeholder."""
    import os
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner}.github.io/{name}"
    return "https://your-username.github.io/your-repo"


def youtube_video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def format_duration(seconds: int | None) -> str:
    """Format seconds into HH:MM:SS or MM:SS."""
    if not seconds:
        return ""
    h, remainder = divmod(seconds, 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def build_description_html(video: dict) -> str:
    """Build HTML description for a single video RSS entry."""
    parts = []

    # Thumbnail
    thumb = video.get("thumbnail_url")
    if thumb:
        vid_url = youtube_video_url(video["video_id"])
        parts.append(
            f'<p><a href="{escape(vid_url)}">'
            f'<img src="{escape(thumb)}" alt="{escape(video.get("title", ""))}" '
            f'style="max-width:480px;"/></a></p>'
        )

    # Channel name
    parts.append(f'<p><strong>{escape(video.get("channel_name", ""))}</strong></p>')

    # AI summary
    summary = video.get("summary_zh")
    if summary:
        parts.append(f"<p>{escape(summary)}</p>")

    # Stats line
    stats = []
    duration = format_duration(video.get("duration_seconds"))
    if duration:
        stats.append(f"片長 {duration}")
    views = video.get("view_count")
    if views is not None:
        stats.append(f"觀看 {views:,}")
    likes = video.get("like_count")
    if likes is not None:
        stats.append(f"讚好 {likes:,}")
    if stats:
        parts.append(f'<p style="color:#666;font-size:0.9em;">{" · ".join(stats)}</p>')

    # Keywords
    keywords = video.get("keywords_zh", [])
    if keywords:
        tags = " ".join(f"#{kw}" for kw in keywords)
        parts.append(f'<p style="color:#888;font-size:0.85em;">{escape(tags)}</p>')

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    base_url = load_base_url()
    log.info(f"Base URL: {base_url}")

    # Determine date range
    today = datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=LOOKBACK_DAYS)

    # Collect videos from recent processed files
    all_videos = []
    for path in sorted(PROCESSED_DIR.glob("*.json"), reverse=True):
        # Parse date from filename
        try:
            file_date = datetime.strptime(path.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if file_date < cutoff:
            break

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            log.warning(f"Skipping {path.name}: {e}")
            continue

        for video in data:
            video["_file_date"] = file_date
            all_videos.append(video)

    # Deduplicate by video_id (keep the most recent file's version)
    seen = set()
    unique_videos = []
    for v in all_videos:
        vid = v.get("video_id")
        if vid and vid not in seen:
            seen.add(vid)
            unique_videos.append(v)

    # Sort by published_at descending
    def sort_key(v):
        try:
            return datetime.fromisoformat(v["published_at"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            return datetime.min.replace(tzinfo=timezone.utc)

    unique_videos.sort(key=sort_key, reverse=True)
    entries = unique_videos[:MAX_ENTRIES]

    log.info(f"Found {len(unique_videos)} unique videos, using {len(entries)} for feed")

    now_rfc = format_datetime(datetime.now(timezone.utc))

    # Build RSS XML
    items_xml = ""
    for v in entries:
        vid_url = youtube_video_url(v["video_id"])
        title = v.get("title", "Untitled")
        channel = v.get("channel_name", "")
        display_title = f"{title} — {channel}" if channel else title

        # Parse published date
        try:
            pub_dt = datetime.fromisoformat(v["published_at"].replace("Z", "+00:00"))
            pub_date = format_datetime(pub_dt)
        except (KeyError, ValueError):
            pub_date = now_rfc

        desc_html = build_description_html(v)

        items_xml += f"""
  <item>
    <title>{escape(display_title)}</title>
    <link>{escape(vid_url)}</link>
    <guid isPermaLink="true">{escape(vid_url)}</guid>
    <pubDate>{pub_date}</pubDate>
    <author>{escape(channel)}</author>
    <description><![CDATA[{desc_html}]]></description>
  </item>"""

    feed_url = f"{base_url}/youtube-feed.xml"
    rss = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{escape(FEED_TITLE)}</title>
    <link>{escape(base_url)}</link>
    <description>{escape(FEED_DESCRIPTION)}</description>
    <language>{FEED_LANGUAGE}</language>
    <lastBuildDate>{now_rfc}</lastBuildDate>
    <atom:link href="{escape(feed_url)}" rel="self" type="application/rss+xml"/>
{items_xml}
  </channel>
</rss>"""

    OUTPUT_PATH.write_text(rss, encoding="utf-8")
    log.info(f"YouTube RSS feed written to {OUTPUT_PATH} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
