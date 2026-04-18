"""
py-helpers: Lightweight FastAPI service for Python-only operations.

Exposes three endpoints that n8n calls via HTTP Request nodes:
  POST /youtube-transcript  — fetch transcript via yt-dlp (primary) or youtube-transcript-api (fallback)
  POST /scrape-article      — extract article text via newspaper4k
  POST /parse-google-trends — parse Google Trends XML into structured items
"""

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from glob import glob as globfiles

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

# Optional: set YT_COOKIES_PATH env var to a Netscape-format cookies.txt
# exported from a browser to bypass YouTube IP blocking.
YT_COOKIES_PATH = os.getenv("YT_COOKIES_PATH")

# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/debug/transcript/{video_id}")
def debug_transcript(video_id: str):
    """Diagnostic endpoint — tries yt-dlp then youtube-transcript-api and
    returns detailed results from both."""
    import traceback
    result = {"video_id": video_id, "cookies_configured": bool(YT_COOKIES_PATH)}

    # yt-dlp probe
    try:
        import yt_dlp
        result["ytdlp_version"] = yt_dlp.version.__version__
        ytdlp_result = _fetch_via_ytdlp(video_id, TRANSCRIPT_LANG_PREFERENCE)
        if ytdlp_result:
            result["ytdlp"] = {
                "success": True,
                "language": ytdlp_result["lang"],
                "source": ytdlp_result["source"],
                "text_length": len(ytdlp_result["text"]),
                "text_preview": ytdlp_result["text"][:200],
            }
        else:
            result["ytdlp"] = {"success": False, "reason": "no subtitles found"}
    except Exception as e:
        result["ytdlp"] = {"success": False, "error": f"{type(e).__name__}: {e}"}

    # youtube-transcript-api probe
    try:
        import youtube_transcript_api
        result["yta_version"] = getattr(youtube_transcript_api, "__version__", "unknown")
        from youtube_transcript_api import YouTubeTranscriptApi
        kwargs = {}
        if YT_COOKIES_PATH and os.path.exists(YT_COOKIES_PATH):
            kwargs["cookies"] = YT_COOKIES_PATH
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id, **kwargs)
        all_t = list(transcript_list)
        result["yta"] = {
            "success": True,
            "transcripts": [
                {"language_code": t.language_code, "is_generated": t.is_generated}
                for t in all_t
            ],
        }
    except Exception as e:
        result["yta"] = {"success": False, "error": f"{type(e).__name__}: {e}"}

    return result


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
    lang_prefs = list(dict.fromkeys(
        (req.lang_prefs or []) + TRANSCRIPT_LANG_PREFERENCE
    ))

    # Primary: yt-dlp (handles datacenter IP blocking much better)
    try:
        result = _fetch_via_ytdlp(req.video_id, lang_prefs)
        if result and result["text"]:
            log.info(
                f"Video {req.video_id}: yt-dlp success lang={result['lang']} "
                f"source={result['source']} len={len(result['text'])}"
            )
            return TranscriptResponse(
                available=True,
                language=result["lang"],
                source=result["source"],
                text=result["text"],
            )
        log.info(f"Video {req.video_id}: yt-dlp returned no subtitles, trying fallback")
    except Exception as e:
        log.warning(f"Video {req.video_id}: yt-dlp failed ({type(e).__name__}: {e}), trying fallback")

    # Fallback: youtube-transcript-api (works from non-blocked IPs)
    try:
        result = _fetch_via_transcript_api(req.video_id, lang_prefs)
        if result:
            return result
    except Exception as e:
        log.warning(f"Video {req.video_id}: transcript-api fallback also failed: {type(e).__name__}: {e}")

    log.warning(f"Video {req.video_id}: all transcript methods failed")
    return TranscriptResponse(available=False)


def _fetch_via_ytdlp(video_id: str, lang_prefs: list[str]) -> dict | None:
    """Fetch subtitles using yt-dlp. More resilient to YouTube IP blocking."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sub_langs = ",".join(lang_prefs)
        cmd = [
            "yt-dlp",
            "--write-auto-sub",
            "--write-sub",
            "--sub-langs", sub_langs,
            "--skip-download",
            "--sub-format", "json3/vtt/srv1/best",
            "--no-warnings",
            "--no-check-certificates",
            "-o", os.path.join(tmpdir, "%(id)s.%(ext)s"),
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        if YT_COOKIES_PATH and os.path.exists(YT_COOKIES_PATH):
            cmd.extend(["--cookies", YT_COOKIES_PATH])

        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if proc.returncode != 0:
            log.warning(f"yt-dlp exit {proc.returncode} for {video_id}: {proc.stderr[:500]}")

        sub_files = sorted(globfiles(os.path.join(tmpdir, f"{video_id}.*")))
        sub_files = [f for f in sub_files if not f.endswith((".mp4", ".webm", ".mkv", ".part"))]

        if not sub_files:
            return None

        # Pick subtitle file by language priority
        chosen_file = sub_files[0]
        for pref in lang_prefs:
            for f in sub_files:
                if f".{pref}." in os.path.basename(f):
                    chosen_file = f
                    break
            else:
                continue
            break

        text = _parse_subtitle_file(chosen_file)
        if not text:
            return None

        basename = os.path.basename(chosen_file)
        parts = basename.split(".")
        lang = parts[1] if len(parts) >= 3 else "unknown"
        is_auto = any(p in basename for p in [".auto.", "-auto."])

        return {
            "text": text,
            "lang": lang,
            "source": "auto" if is_auto else "manual",
        }


def _parse_subtitle_file(filepath: str) -> str:
    ext = filepath.rsplit(".", 1)[-1].lower()

    with open(filepath, encoding="utf-8") as f:
        content = f.read()

    if ext == "json3":
        try:
            data = json.loads(content)
            events = data.get("events", [])
            return " ".join(
                "".join(seg.get("utf8", "") for seg in event.get("segs", []))
                for event in events if event.get("segs")
            ).strip()
        except (json.JSONDecodeError, KeyError):
            pass

    # VTT / SRT / other text formats
    lines = content.splitlines()
    text_lines = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith(("WEBVTT", "NOTE", "Kind:", "Language:")):
            continue
        if "-->" in line:
            continue
        if line.isdigit():
            continue
        line = re.sub(r"<[^>]+>", "", line)
        text_lines.append(line)

    return " ".join(text_lines).strip()


def _fetch_via_transcript_api(video_id: str, lang_prefs: list[str]) -> TranscriptResponse | None:
    """Fallback: use youtube-transcript-api (works when IP isn't blocked)."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return None

    kwargs = {}
    if YT_COOKIES_PATH and os.path.exists(YT_COOKIES_PATH):
        kwargs["cookies"] = YT_COOKIES_PATH

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id, **kwargs)
    except Exception as e:
        log.info(f"transcript-api list_transcripts failed for {video_id}: {type(e).__name__}")
        return None

    all_transcripts = list(transcript_list)
    if not all_transcripts:
        return None

    lang_rank = {code.lower(): i for i, code in enumerate(lang_prefs)}

    def score(t):
        manual_rank = 0 if not t.is_generated else 1
        code = (t.language_code or "").lower()
        if code in lang_rank:
            return (manual_rank, lang_rank[code])
        prefix_scores = [
            rank for pref, rank in lang_rank.items()
            if code.startswith(pref.split("-")[0])
        ]
        return (manual_rank, min(prefix_scores) + 1000 if prefix_scores else 9999)

    ranked = sorted(all_transcripts, key=score)

    for t in ranked:
        try:
            entries = t.fetch()
            text = " ".join(
                e.get("text", "") if isinstance(e, dict) else getattr(e, "text", "")
                for e in entries
            ).strip()
            if text:
                log.info(f"Video {video_id}: transcript-api success lang={t.language_code} len={len(text)}")
                return TranscriptResponse(
                    available=True,
                    language=t.language_code,
                    source="auto" if t.is_generated else "manual",
                    text=text,
                )
        except Exception:
            continue

    return None


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
