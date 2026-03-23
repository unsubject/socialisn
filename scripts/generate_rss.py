"""
generate_rss.py
Module 5a: RSS Feed Generator

Reads all Markdown briefings from data/briefings/ and generates a valid
RSS 2.0 feed at docs/feed.xml. Each briefing becomes one RSS entry with
full HTML content. Sorted newest first, capped at 30 entries.

Run:    python scripts/generate_rss.py
"""

import logging
import re
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

import markdown

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIEFINGS_DIR = REPO_ROOT / "data" / "briefings"
DOCS_DIR = REPO_ROOT / "docs"
OUTPUT_PATH = DOCS_DIR / "feed.xml"
MAX_ENTRIES = 30

FEED_TITLE = "情報簡報 Intelligence Briefing"
FEED_DESCRIPTION = "每日香港及國際時事情報簡報，由 AI 自動生成"
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

def parse_briefing_filename(path: Path) -> tuple[str, str, datetime] | None:
    """
    Parse filename like 2026-03-22-morning.md
    Returns (date_str, slot, datetime) or None if unparseable.
    """
    stem = path.stem  # e.g. 2026-03-22-morning
    match = re.match(r"(\d{4}-\d{2}-\d{2})-(morning|evening)", stem)
    if not match:
        return None
    date_str = match.group(1)
    slot = match.group(2)
    # morning = 00:00 UTC, evening = 12:00 UTC
    hour = 0 if slot == "morning" else 12
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d").replace(
            hour=hour, tzinfo=timezone.utc
        )
        return date_str, slot, dt
    except ValueError:
        return None


def slot_label(slot: str) -> str:
    return "早報" if slot == "morning" else "晚報"


def briefing_html_url(date_str: str, slot: str, base_url: str) -> str:
    return f"{base_url}/briefings/{date_str}-{slot}.html"


def md_to_html(md_text: str) -> str:
    return markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "nl2br"]
    )


def load_base_url() -> str:
    """Try to read GitHub Pages URL from environment, fall back to placeholder."""
    import os
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner}.github.io/{name}"
    return "https://your-username.github.io/your-repo"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    base_url = load_base_url()
    log.info(f"Base URL: {base_url}")

    # Collect all briefing files
    briefing_files = list(BRIEFINGS_DIR.glob("*.md"))
    if not briefing_files:
        log.warning("No briefing files found. Generating empty feed.")

    # Parse and sort newest first
    entries = []
    for path in briefing_files:
        parsed = parse_briefing_filename(path)
        if not parsed:
            continue
        date_str, slot, dt = parsed
        content = path.read_text(encoding="utf-8")
        entries.append({
            "date_str": date_str,
            "slot": slot,
            "dt": dt,
            "title": f"【情報簡報】{date_str} {slot_label(slot)}",
            "link": briefing_html_url(date_str, slot, base_url),
            "content_html": md_to_html(content),
            "pub_date": format_datetime(dt),
            "guid": briefing_html_url(date_str, slot, base_url),
        })

    entries.sort(key=lambda x: x["dt"], reverse=True)
    entries = entries[:MAX_ENTRIES]

    now_rfc = format_datetime(datetime.now(timezone.utc))

    # Build RSS XML
    items_xml = ""
    for e in entries:
        content_escaped = escape(e["content_html"])
        items_xml += f"""
  <item>
    <title>{escape(e["title"])}</title>
    <link>{escape(e["link"])}</link>
    <guid isPermaLink="true">{escape(e["guid"])}</guid>
    <pubDate>{e["pub_date"]}</pubDate>
    <description><![CDATA[{e["content_html"]}]]></description>
  </item>"""

    rss = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{escape(FEED_TITLE)}</title>
    <link>{escape(base_url)}</link>
    <description>{escape(FEED_DESCRIPTION)}</description>
    <language>{FEED_LANGUAGE}</language>
    <lastBuildDate>{now_rfc}</lastBuildDate>
    <atom:link href="{escape(base_url)}/feed.xml" rel="self" type="application/rss+xml"/>
{items_xml}
  </channel>
</rss>"""

    OUTPUT_PATH.write_text(rss, encoding="utf-8")
    log.info(f"RSS feed written to {OUTPUT_PATH} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
