"""
generate_podcast_rss.py
Module 5d: Podcast RSS Feed Generator

Reads processed podcast data and generates an RSS 2.0 feed at
docs/podcast-feed.xml. Each episode becomes one RSS entry with title,
podcast name, summary, and link. Sorted newest first, capped at 100
entries from the last 7 days.

Run:    python scripts/generate_podcast_rss.py
"""

import json
import logging
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from xml.sax.saxutils import escape

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIR = REPO_ROOT / "data" / "podcasts" / "processed"
DOCS_DIR = REPO_ROOT / "docs"
OUTPUT_PATH = DOCS_DIR / "podcast-feed.xml"
MAX_ENTRIES = 100
LOOKBACK_DAYS = 7

FEED_TITLE = "Podcast 監察 Podcast Monitor"
FEED_DESCRIPTION = "精選財經及科技 Podcast 最新集數，自動監察更新"
FEED_LANGUAGE = "en"

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
    import os
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner}.github.io/{name}"
    return "https://your-username.github.io/your-repo"


def format_duration(seconds: int | None) -> str:
    if not seconds:
        return ""
    h, remainder = divmod(seconds, 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def parse_pub_date(published_at: str | None) -> datetime | None:
    """Parse various date formats into a timezone-aware datetime."""
    if not published_at:
        return None
    try:
        return datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        return parsedate_to_datetime(published_at)
    except Exception:
        pass
    return None


def build_description_html(episode: dict) -> str:
    """Build HTML description for a single podcast episode RSS entry."""
    parts = []

    # Podcast name
    podcast = episode.get("podcast_name", "")
    if podcast:
        parts.append(f'<p><strong>{escape(podcast)}</strong></p>')

    # AI summary
    summary = episode.get("summary_zh")
    if summary:
        parts.append(f"<p>{escape(summary)}</p>")

    # Original description (truncated)
    desc = episode.get("description", "")
    if desc:
        if len(desc) > 500:
            desc = desc[:500] + "..."
        parts.append(f'<p style="color:#555;">{escape(desc)}</p>')

    # Stats line
    stats = []
    duration = format_duration(episode.get("duration_seconds"))
    if duration:
        stats.append(f"Duration: {duration}")
    ep_num = episode.get("episode_number")
    if ep_num:
        stats.append(f"Ep. {ep_num}")
    if stats:
        parts.append(f'<p style="color:#666;font-size:0.9em;">{" · ".join(stats)}</p>')

    # Keywords
    keywords = episode.get("keywords_zh", [])
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

    today = datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=LOOKBACK_DAYS)

    # Collect episodes from recent processed files
    all_episodes = []
    for path in sorted(PROCESSED_DIR.glob("*.json"), reverse=True):
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

        all_episodes.extend(data)

    # Deduplicate by episode_id
    seen = set()
    unique = []
    for ep in all_episodes:
        eid = ep.get("episode_id")
        if eid and eid not in seen:
            seen.add(eid)
            unique.append(ep)

    # Sort by published_at descending
    def sort_key(ep):
        dt = parse_pub_date(ep.get("published_at"))
        return dt if dt else datetime.min.replace(tzinfo=timezone.utc)

    unique.sort(key=sort_key, reverse=True)
    entries = unique[:MAX_ENTRIES]

    log.info(f"Found {len(unique)} unique episodes, using {len(entries)} for feed")

    now_rfc = format_datetime(datetime.now(timezone.utc))

    # Build RSS XML
    items_xml = ""
    for ep in entries:
        episode_url = ep.get("episode_url", "")
        title = ep.get("title", "Untitled")
        podcast = ep.get("podcast_name", "")
        display_title = f"{title} — {podcast}" if podcast else title

        pub_dt = parse_pub_date(ep.get("published_at"))
        pub_date = format_datetime(pub_dt) if pub_dt else now_rfc

        desc_html = build_description_html(ep)

        # Use episode_url or audio_url as link
        link = episode_url or ep.get("audio_url", "")
        guid = ep.get("episode_id", link)

        items_xml += f"""
  <item>
    <title>{escape(display_title)}</title>
    <link>{escape(link)}</link>
    <guid isPermaLink="false">{escape(guid)}</guid>
    <pubDate>{pub_date}</pubDate>
    <author>{escape(podcast)}</author>
    <description><![CDATA[{desc_html}]]></description>
  </item>"""

    feed_url = f"{base_url}/podcast-feed.xml"
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
    log.info(f"Podcast RSS feed written to {OUTPUT_PATH} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
