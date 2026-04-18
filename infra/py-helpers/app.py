"""
py-helpers: Lightweight FastAPI service for Python-only operations.

Exposes three endpoints that n8n calls via HTTP Request nodes:
  POST /youtube-transcript  — fetch transcript via youtube-transcript-api
  POST /scrape-article      — extract article text via newspaper4k
  POST /parse-google-trends — parse Google Trends XML into structured items
"""

import hashlib
import logging
import xml.etree.ElementTree as ET

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="socialisn-helpers", version="1.0.0")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)

TRANSCRIPT_LANG_PREFERENCE = ["zh-TW", "zh-Hant", "zh-Hans", "zh-CN", "zh", "en"]
MAX_FULL_TEXT_CHARS = 5000

# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── YouTube Transcript ────────────────────────────────────────────────────────

class TranscriptRequest(BaseModel):
    video_id: str
    lang_prefs: list[str] | None = None

class TranscriptResponse(BaseModel):
    available: bool
    language: str | None = None
    source: str | None = None
    text: str | None = None

@app.post("/youtube-transcript", response_model=TranscriptResponse)
def youtube_transcript(req: TranscriptRequest):
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled,
            VideoUnavailable,
        )
    except ImportError as e:
        log.error(f"youtube-transcript-api import failed (wrong version?): {e}")
        return TranscriptResponse(available=False)

    null = TranscriptResponse(available=False)

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(req.video_id)
    except (TranscriptsDisabled, VideoUnavailable) as e:
        log.info(f"No transcripts for {req.video_id}: {type(e).__name__}")
        return null
    except Exception as e:
        log.error(f"Transcript list error for {req.video_id}: {type(e).__name__}: {e}")
        return null

    try:
        all_transcripts = list(transcript_list)
    except Exception as e:
        log.warning(f"Could not enumerate transcripts for {req.video_id}: {e}")
        all_transcripts = []

    available = [
        f"{t.language_code}({'gen' if t.is_generated else 'man'})"
        for t in all_transcripts
    ]
    log.info(f"Video {req.video_id}: available transcripts: {available}")

    if not all_transcripts:
        log.warning(f"Video {req.video_id}: no transcripts returned from API")
        return null

    lang_pref = list(dict.fromkeys(
        (req.lang_prefs or []) + TRANSCRIPT_LANG_PREFERENCE
    ))
    # Case-insensitive lookup: map normalized code → priority rank
    lang_rank = {code.lower(): i for i, code in enumerate(lang_pref)}

    def score(t):
        # (manual before generated, language-priority, original order)
        manual_rank = 0 if not t.is_generated else 1
        code = (t.language_code or "").lower()
        # Exact match first; then fall back to prefix match (e.g. "zh" matches "zh-HK")
        if code in lang_rank:
            lang_score = lang_rank[code]
        else:
            prefix_scores = [
                rank for pref, rank in lang_rank.items()
                if code.startswith(pref.split("-")[0])
            ]
            lang_score = min(prefix_scores) + 1000 if prefix_scores else 9999
        return (manual_rank, lang_score)

    ranked = sorted(all_transcripts, key=score)
    chosen = ranked[0]

    try:
        entries = chosen.fetch()
    except Exception as e:
        log.error(f"Transcript fetch error for {req.video_id} lang={chosen.language_code}: {type(e).__name__}: {e}")
        # Try the next-best option as a secondary fallback
        for alt in ranked[1:]:
            try:
                entries = alt.fetch()
                chosen = alt
                break
            except Exception:
                continue
        else:
            return null

    try:
        text = " ".join(_entry_text(e) for e in entries).strip()
    except Exception as e:
        log.error(f"Transcript decode error for {req.video_id}: {type(e).__name__}: {e}")
        return null

    log.info(
        f"Video {req.video_id}: returning transcript lang={chosen.language_code} "
        f"source={'auto' if chosen.is_generated else 'manual'} len={len(text)}"
    )
    return TranscriptResponse(
        available=True,
        language=chosen.language_code,
        source="auto" if chosen.is_generated else "manual",
        text=text,
    )


def _entry_text(e) -> str:
    """Handle both v0.6.x (dict with 'text' key) and v1.x (object with .text attr)."""
    if isinstance(e, dict):
        return e.get("text", "")
    return getattr(e, "text", "")


# ── Article Scraping ──────────────────────────────────────────────────────────

class ScrapeRequest(BaseModel):
    url: str

class ScrapeResponse(BaseModel):
    title: str | None = None
    full_text: str | None = None
    published_at: str | None = None

@app.post("/scrape-article", response_model=ScrapeResponse)
def scrape_article(req: ScrapeRequest):
    from newspaper import Article

    try:
        article = Article(req.url)
        article.download()
        article.parse()
        text = (article.text or "").strip()
        if len(text) > MAX_FULL_TEXT_CHARS:
            text = text[:MAX_FULL_TEXT_CHARS] + "..."
        pub = None
        if article.publish_date:
            pub = article.publish_date.isoformat()
        return ScrapeResponse(
            title=article.title or None,
            full_text=text or None,
            published_at=pub,
        )
    except Exception as e:
        log.warning(f"newspaper4k failed for {req.url}: {e}")
        return ScrapeResponse()


# ── Google Trends XML ─────────────────────────────────────────────────────────

HT_NS = "https://trends.google.com/trending/rss"

_SKIP_SOURCES = {
    "ETtoday新聞雲", "Yahoo奇摩新聞", "Yahoo News",
    "中時新聞網", "三立新聞",
}
_SKIP_TITLE_KEYWORDS = [
    "NBA", "MLB", "棒球", "籃球", "足球", "體育",
    "選秀", "偶像", "綜藝", "演唱會", "電影",
]

class TrendsRequest(BaseModel):
    xml: str

class TrendItem(BaseModel):
    headline: str
    published_at: str | None = None
    approx_traffic: str | None = None
    article_id: str
    url: str
    excerpt: str | None = None
    full_text: str | None = None
    related_news: list[dict] | None = None

@app.post("/parse-google-trends", response_model=list[TrendItem])
def parse_google_trends(req: TrendsRequest):
    try:
        root = ET.fromstring(req.xml)
    except ET.ParseError as e:
        log.error(f"XML parse failed: {e}")
        return []

    results = []
    for item in root.findall(".//item"):
        headline = (item.findtext("title") or "").strip()
        if not headline:
            continue

        published_at = item.findtext("pubDate")
        approx_traffic = item.findtext(f"{{{HT_NS}}}approx_traffic") or ""

        news_items = []
        for ni in item.findall(f"{{{HT_NS}}}news_item"):
            ni_title = ni.findtext(f"{{{HT_NS}}}news_item_title") or ""
            ni_url = ni.findtext(f"{{{HT_NS}}}news_item_url") or ""
            ni_source = ni.findtext(f"{{{HT_NS}}}news_item_source") or ""
            ni_snippet = ni.findtext(f"{{{HT_NS}}}news_item_snippet") or ""
            if ni_url:
                news_items.append({
                    "title": ni_title, "url": ni_url,
                    "source": ni_source, "snippet": ni_snippet,
                })

        if not _is_relevant(news_items):
            continue

        full_text_parts = [f"熱搜關鍵字: {headline}"]
        if approx_traffic:
            full_text_parts.append(f"搜尋量: {approx_traffic}")
        for ni in news_items:
            line = f"- {ni['title']} ({ni['source']})"
            if ni["snippet"]:
                line += f": {ni['snippet']}"
            full_text_parts.append(line)

        unique_key = f"gtrends-{headline}-{published_at or ''}"
        aid = hashlib.sha1(unique_key.encode()).hexdigest()[:16]

        results.append(TrendItem(
            headline=headline,
            published_at=published_at,
            approx_traffic=approx_traffic,
            article_id=aid,
            url=news_items[0]["url"] if news_items else "",
            excerpt=news_items[0]["title"] if news_items else None,
            full_text="\n".join(full_text_parts) if news_items else None,
            related_news=news_items or None,
        ))

    return results


def _is_relevant(news_items: list[dict]) -> bool:
    if not news_items:
        return True
    for ni in news_items:
        if ni.get("source", "") in _SKIP_SOURCES:
            continue
        title_lower = ni.get("title", "").lower()
        if any(kw.lower() in title_lower for kw in _SKIP_TITLE_KEYWORDS):
            continue
        return True
    return False
