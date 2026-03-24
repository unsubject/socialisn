"""
fetch_news.py
Module 2b: News Fetcher

Fetches articles from news sources listed in config/news_sources.yaml.
Supports two source types:
  - rss:    Parse RSS/Atom feed via feedparser, then extract full article
            text from each item URL using newspaper3k
  - scrape: Fetch page with requests+BeautifulSoup, extract headline and
            visible body text using a CSS selector hint (if provided)

Deduplicates by article URL within the daily file.
Output: data/news/raw/YYYY-MM-DD.json  (appends; deduplicates by article_id)

Run:    python scripts/fetch_news.py
"""

import hashlib
import json
import logging
import time
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

import feedparser
import requests
import yaml
from bs4 import BeautifulSoup
from newspaper import Article

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "news_sources.yaml"
RAW_DATA_DIR = REPO_ROOT / "data" / "news" / "raw"
LOOKBACK_HOURS = 24

# Seconds between requests — be polite to servers
REQUEST_DELAY = 1.0

# Request headers — identify the bot politely
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; IntelligenceMonitorBot/1.0; "
        "+https://github.com)"
    )
}

# Max chars of full article text to store (newspaper3k can return very long text)
MAX_FULL_TEXT_CHARS = 5000

# Max chars of visible text for scrape sources
MAX_SCRAPE_TEXT_CHARS = 3000

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers — general
# ---------------------------------------------------------------------------

def make_article_id(url: str) -> str:
    """Stable ID from URL — SHA1 hex, first 16 chars."""
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def load_sources() -> list[dict]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
    sources = config.get("sources", [])
    log.info(f"Loaded {len(sources)} sources from config.")
    return sources


def is_within_lookback(published_at: str | None, lookback_hours: int) -> bool:
    """Return True if published_at is within the lookback window."""
    if not published_at:
        return True  # Include if no date available
    try:
        # Try ISO 8601 first
        try:
            pub = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
        except ValueError:
            # Try RFC 2822 (common in RSS)
            pub = parsedate_to_datetime(published_at)
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
        return pub >= cutoff
    except Exception:
        return True  # Include if date parsing fails


# ---------------------------------------------------------------------------
# Helpers — RSS
# ---------------------------------------------------------------------------

def extract_full_text(url: str) -> str | None:
    """Use newspaper3k to extract full article text from a URL."""
    try:
        article = Article(url)
        article.download()
        article.parse()
        text = article.text.strip()
        if len(text) > MAX_FULL_TEXT_CHARS:
            text = text[:MAX_FULL_TEXT_CHARS] + "..."
        return text if text else None
    except Exception as e:
        log.warning(f"    newspaper3k failed for {url}: {e}")
        return None


def fetch_rss_source(source: dict, fetched_at: str) -> list[dict]:
    """Fetch and parse an RSS/Atom feed, extract full text for each item."""
    name = source["name"]
    url = source["url"]
    language = source.get("language", "en")
    tags = source.get("tags", [])

    log.info(f"  Fetching RSS: {name}")

    try:
        feed = feedparser.parse(url)
    except Exception as e:
        log.error(f"  RSS parse failed for {name}: {e}")
        return []

    if feed.bozo and not feed.entries:
        log.warning(f"  RSS feed malformed or empty: {name}")
        return []

    records = []
    for entry in feed.entries:
        article_url = entry.get("link", "")
        if not article_url:
            continue

        # Parse published date
        published_at = None
        for date_field in ("published", "updated", "created"):
            raw_date = entry.get(date_field)
            if raw_date:
                published_at = raw_date
                break

        # Skip if outside lookback window
        if not is_within_lookback(published_at, LOOKBACK_HOURS):
            continue

        headline = entry.get("title", "").strip()
        excerpt = entry.get("summary", "").strip()

        # Strip HTML from excerpt if present
        if excerpt and "<" in excerpt:
            excerpt = BeautifulSoup(excerpt, "html.parser").get_text(
                separator=" ", strip=True
            )

        # Extract full article text
        log.info(f"    Extracting full text: {headline[:60]}")
        full_text = extract_full_text(article_url)
        time.sleep(REQUEST_DELAY)

        # Extract Google Trends-specific fields if present
        approx_traffic = entry.get("ht_approx_traffic", None)
        news_items = []
        for ni in entry.get("ht_news_item", []):
            if isinstance(ni, dict):
                news_items.append({
                    "title": ni.get("ht_news_item_title", ""),
                    "url": ni.get("ht_news_item_url", ""),
                    "source": ni.get("ht_news_item_source", ""),
                })

        record = {
            "article_id": make_article_id(article_url),
            "source_name": name,
            "source_type": "rss",
            "url": article_url,
            "headline": headline,
            "excerpt": excerpt[:500] if excerpt else None,
            "full_text": full_text,
            "published_at": published_at,
            "fetched_at": fetched_at,
            "language": language,
            "tags": tags,
        }
        if approx_traffic:
            record["approx_traffic"] = approx_traffic
        if news_items:
            record["related_news"] = news_items

        records.append(record)

    log.info(f"  Found {len(records)} article(s) within lookback window.")
    return records


# ---------------------------------------------------------------------------
# Helpers — Scrape
# ---------------------------------------------------------------------------

def get_visible_text(soup: BeautifulSoup) -> str:
    """Extract human-readable visible text from a BeautifulSoup object."""
    # Remove script, style, nav, footer, header noise
    for tag in soup(["script", "style", "nav", "footer", "header",
                     "aside", "form", "iframe"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    # Collapse excessive blank lines
    import re
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def fetch_scrape_source(source: dict, fetched_at: str) -> list[dict]:
    """
    Scrape a page for article links, then fetch headline + visible text
    for each article linked from the page.
    """
    name = source["name"]
    url = source["url"]
    language = source.get("language", "en")
    tags = source.get("tags", [])
    selector = source.get("selector", "a")

    log.info(f"  Fetching scrape: {name} ({url})")

    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        log.error(f"  Request failed for {name}: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    base_url = "/".join(url.split("/")[:3])  # e.g. https://example.com

    # Find article links using selector
    links = soup.select(selector)
    article_urls = []
    seen = set()
    for link in links:
        href = link.get("href", "")
        if not href or href.startswith("#") or href.startswith("javascript"):
            continue
        # Resolve relative URLs
        if href.startswith("/"):
            href = base_url + href
        elif not href.startswith("http"):
            continue
        if href not in seen:
            seen.add(href)
            article_urls.append((link.get_text(strip=True), href))

    if not article_urls:
        log.warning(f"  No article links found for {name} with selector '{selector}'")
        return []

    log.info(f"  Found {len(article_urls)} link(s). Fetching article pages...")

    records = []
    for headline_text, article_url in article_urls[:20]:  # cap at 20 per source
        try:
            art_resp = requests.get(article_url, headers=HEADERS, timeout=15)
            art_resp.raise_for_status()
        except Exception as e:
            log.warning(f"    Failed to fetch {article_url}: {e}")
            time.sleep(REQUEST_DELAY)
            continue

        art_soup = BeautifulSoup(art_resp.text, "html.parser")

        # Try to get a better headline from the page itself
        page_headline = ""
        for tag in ("h1", "h2"):
            el = art_soup.find(tag)
            if el:
                page_headline = el.get_text(strip=True)
                break
        headline = page_headline or headline_text

        # Get meta description as excerpt
        meta_desc = ""
        meta = art_soup.find("meta", attrs={"name": "description"})
        if meta:
            meta_desc = meta.get("content", "").strip()

        # Get visible text
        visible_text = get_visible_text(art_soup)
        if len(visible_text) > MAX_SCRAPE_TEXT_CHARS:
            visible_text = visible_text[:MAX_SCRAPE_TEXT_CHARS] + "..."

        records.append({
            "article_id": make_article_id(article_url),
            "source_name": name,
            "source_type": "scrape",
            "url": article_url,
            "headline": headline,
            "excerpt": meta_desc[:500] if meta_desc else None,
            "full_text": visible_text if visible_text else None,
            "published_at": None,  # scrape sources often don't expose pub date
            "fetched_at": fetched_at,
            "language": language,
            "tags": tags,
        })

        log.info(f"    Scraped: {headline[:60]}")
        time.sleep(REQUEST_DELAY)

    log.info(f"  Scraped {len(records)} article(s) from {name}.")
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
    return {r["article_id"]: r for r in records}


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
    sources = load_sources()

    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")
    fetched_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    existing = load_existing_records(date_str)
    new_count = 0

    for source in sources:
        source_type = source.get("type", "").lower()

        if source_type == "rss":
            records = fetch_rss_source(source, fetched_at)
        elif source_type == "scrape":
            records = fetch_scrape_source(source, fetched_at)
        else:
            log.warning(f"Unknown source type '{source_type}' for {source.get('name')}. Skipping.")
            continue

        for record in records:
            aid = record["article_id"]
            if aid in existing:
                log.info(f"  Skipping duplicate: {record.get('headline', aid)[:60]}")
                continue
            existing[aid] = record
            new_count += 1

    save_records(date_str, existing)
    log.info(f"Done. {new_count} new article(s) added.")


if __name__ == "__main__":
    main()
