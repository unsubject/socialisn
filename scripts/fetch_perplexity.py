"""
fetch_perplexity.py
Module 2c: Perplexity Search News Fetcher

Uses Perplexity's Sonar API to actively search for top news in the past 24 hours
across configured topics (Hong Kong, China, Global economy/finance/politics).

Each search query produces a structured response with citations. We extract
individual articles from the citations and store them in the same format as
fetch_news.py for downstream processing by process_with_haiku.py.

Output: data/news/raw/YYYY-MM-DD.json  (merges with existing; deduplicates)

Run:    python scripts/fetch_perplexity.py
Env:    PERPLEXITY_API_KEY — Perplexity API key (set as GitHub Secret)
"""

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DATA_DIR = REPO_ROOT / "data" / "news" / "raw"

PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions"
PERPLEXITY_MODEL = "sonar"

# Seconds between API calls — respect rate limits
RATE_LIMIT_DELAY = 2.0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Search queries — 15 queries across HK, China, Global
# ---------------------------------------------------------------------------

SEARCH_QUERIES = [
    # --- Hong Kong: Economy & Finance (5 queries) ---
    {
        "query": "Hong Kong economy and financial market news today",
        "tags": ["hongkong", "economics", "finance"],
        "language": "en",
    },
    {
        "query": "香港經濟 金融市場 今日新聞",
        "tags": ["hongkong", "economics", "finance", "chinese"],
        "language": "zh-TW",
    },
    {
        "query": "Hong Kong stock market IPO investment news today",
        "tags": ["hongkong", "finance", "stock-market"],
        "language": "en",
    },
    {
        "query": "Hong Kong property market real estate news today",
        "tags": ["hongkong", "economics", "property"],
        "language": "en",
    },
    {
        "query": "HKMA monetary policy Hong Kong banking regulation news",
        "tags": ["hongkong", "monetary-policy", "government"],
        "language": "en",
    },

    # --- Hong Kong: Politics & Top News (3 queries) ---
    {
        "query": "Hong Kong government policy political news today",
        "tags": ["hongkong", "politics"],
        "language": "en",
    },
    {
        "query": "香港政治 政府政策 今日重要新聞",
        "tags": ["hongkong", "politics", "chinese"],
        "language": "zh-TW",
    },
    {
        "query": "Hong Kong top breaking news today",
        "tags": ["hongkong", "general"],
        "language": "en",
    },

    # --- China: Economy & Central Government (4 queries) ---
    {
        "query": "China economy GDP trade policy news today",
        "tags": ["china", "economics"],
        "language": "en",
    },
    {
        "query": "中國經濟 中央政府政策 今日新聞",
        "tags": ["china", "economics", "politics", "chinese"],
        "language": "zh-TW",
    },
    {
        "query": "China central government political decisions policy news today",
        "tags": ["china", "politics"],
        "language": "en",
    },
    {
        "query": "China financial market regulation technology sector news today",
        "tags": ["china", "finance", "technology"],
        "language": "en",
    },

    # --- Global: Economy (3 queries) ---
    {
        "query": "Global economy world financial market news today",
        "tags": ["global", "economics", "finance"],
        "language": "en",
    },
    {
        "query": "US Federal Reserve interest rate global monetary policy news today",
        "tags": ["global", "monetary-policy"],
        "language": "en",
    },
    {
        "query": "Global trade tariffs geopolitics economic impact news today",
        "tags": ["global", "economics", "trade"],
        "language": "en",
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_article_id(url: str) -> str:
    """Stable ID from URL — SHA1 hex, first 16 chars."""
    return hashlib.sha1(url.encode()).hexdigest()[:16]


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


def search_perplexity(api_key: str, query: str) -> dict | None:
    """Call Perplexity Sonar API with web search for recent news."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    system_prompt = (
        "You are a news research assistant. Return ONLY the top news stories "
        "from the past 24 hours matching the query. For each story, provide: "
        "the headline, a 1-2 sentence summary, and the source name. "
        "Format each story as a numbered list. Be factual and concise."
    )

    payload = {
        "model": PERPLEXITY_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ],
        "search_recency_filter": "day",
        "return_citations": True,
        "web_search_options": {"search_context_size": "medium"},
        "temperature": 0.1,
    }

    try:
        resp = requests.post(
            PERPLEXITY_API_URL,
            headers=headers,
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        log.error(f"  Perplexity API error: {e}")
        return None


def extract_articles_from_response(
    response: dict,
    query_config: dict,
    fetched_at: str,
) -> list[dict]:
    """Extract article records from a Perplexity response + citations."""
    if not response:
        return []

    content = ""
    if response.get("choices"):
        content = response["choices"][0].get("message", {}).get("content", "")

    citations = response.get("citations", [])
    search_results = response.get("search_results", [])

    if not citations:
        log.warning("  No citations returned from Perplexity.")
        return []

    tags = query_config["tags"]
    language = query_config["language"]
    records = []

    # Build a title lookup from search_results
    title_by_url = {}
    for sr in search_results:
        if isinstance(sr, dict) and sr.get("url"):
            title_by_url[sr["url"]] = sr.get("title", "")

    for citation_url in citations:
        if not isinstance(citation_url, str) or not citation_url.startswith("http"):
            continue

        article_id = make_article_id(citation_url)
        headline = title_by_url.get(citation_url, "")

        # If no title from search_results, derive from URL
        if not headline:
            # Use the URL path as a rough headline
            from urllib.parse import urlparse
            path = urlparse(citation_url).path
            headline = path.strip("/").split("/")[-1].replace("-", " ").title()

        records.append({
            "article_id": article_id,
            "source_name": "Perplexity Search",
            "source_type": "perplexity",
            "url": citation_url,
            "headline": headline,
            "excerpt": None,
            "full_text": content if len(citations) == 1 else None,
            "published_at": None,
            "fetched_at": fetched_at,
            "language": language,
            "tags": tags,
        })

    return records


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    api_key = os.environ.get("PERPLEXITY_API_KEY", "")
    if not api_key:
        log.error("PERPLEXITY_API_KEY not set. Skipping Perplexity search.")
        return

    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")
    fetched_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    existing = load_existing_records(date_str)
    new_count = 0

    log.info(f"Running {len(SEARCH_QUERIES)} Perplexity search queries...")

    for i, query_config in enumerate(SEARCH_QUERIES, 1):
        query = query_config["query"]
        log.info(f"  [{i}/{len(SEARCH_QUERIES)}] Searching: {query[:60]}")

        response = search_perplexity(api_key, query)
        if not response:
            continue

        articles = extract_articles_from_response(response, query_config, fetched_at)
        log.info(f"    Got {len(articles)} citation(s)")

        for record in articles:
            aid = record["article_id"]
            if aid in existing:
                log.info(f"    Skipping duplicate: {record['headline'][:50]}")
                continue
            existing[aid] = record
            new_count += 1

        # Rate limit between queries
        if i < len(SEARCH_QUERIES):
            time.sleep(RATE_LIMIT_DELAY)

    save_records(date_str, existing)
    log.info(f"Done. {new_count} new article(s) added from Perplexity.")


if __name__ == "__main__":
    main()
