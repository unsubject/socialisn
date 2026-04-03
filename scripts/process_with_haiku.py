"""
process_with_haiku.py
Module 3: Haiku Processing Layer

Reads today's raw data for all source types (YouTube, news) and generates:
  - summary_zh: 1–2 sentence Traditional Chinese summary (headline style)
  - keywords_zh: 5–8 Traditional Chinese keywords (from title only)

Outputs:
  data/youtube/processed/YYYY-MM-DD.json
  data/news/processed/YYYY-MM-DD.json

Run:    python scripts/process_with_haiku.py [--source youtube|news|all]
        Default: all
Env:    ANTHROPIC_API_KEY — Anthropic API key (set as GitHub Secret)
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import anthropic

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

import argparse

REPO_ROOT = Path(__file__).resolve().parent.parent

# Source configurations: maps source name -> (raw_dir, processed_dir, text_field, title_field)
SOURCES = {
    "youtube": {
        "raw_dir": REPO_ROOT / "data" / "youtube" / "raw",
        "processed_dir": REPO_ROOT / "data" / "youtube" / "processed",
        "title_field": "title",
        "text_fields": ["description", "transcript.text"],
    },
    "news": {
        "raw_dir": REPO_ROOT / "data" / "news" / "raw",
        "processed_dir": REPO_ROOT / "data" / "news" / "processed",
        "title_field": "headline",
        "text_fields": ["excerpt", "full_text"],
    },
    "podcasts": {
        "raw_dir": REPO_ROOT / "data" / "podcasts" / "raw",
        "processed_dir": REPO_ROOT / "data" / "podcasts" / "processed",
        "title_field": "title",
        "text_fields": ["description"],
    },
}

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 256
# Seconds to wait between API calls to avoid rate limiting
RATE_LIMIT_DELAY = 0.5

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Description cleaning
# ---------------------------------------------------------------------------

def clean_description(text: str) -> str:
    """
    Strip noise from YouTube descriptions before sending to Haiku:
    - URLs (http/https)
    - Hashtags (#tag)
    - Common sponsor/boilerplate patterns (Patreon, NordVPN, etc.)
    - Repeated blank lines
    Preserves genuine editorial content.
    """
    # Remove URLs
    text = re.sub(r"https?://\S+", "", text)

    # Remove hashtags
    text = re.sub(r"#\S+", "", text)

    # Remove common boilerplate trigger phrases and rest of that line
    boilerplate_patterns = [
        r"patreon.*",
        r"buymeacoffee.*",
        r"buy me a coffee.*",
        r"nordvpn.*",
        r"coffee support.*",
        r"課金支持.*",
        r"支持.*頻道.*",
        r"訂閱.*頻道.*",
        r"成為.*會員.*",
        r"追踪.*動向.*",
        r"優惠碼.*",
        r"discount code.*",
        r"promo code.*",
        r"affiliate.*",
        r"請我.*咖啡.*",
        r"ig:.*",
        r"fb:.*",
        r"twitter:.*",
        r"mewe:.*",
        r"telegram:.*",
    ]
    for pattern in boilerplate_patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)

    # Collapse multiple blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    # Strip each line; drop lines that are just punctuation or very short
    lines = [line.strip() for line in text.splitlines()]
    lines = [l for l in lines if len(l) > 2]

    return "\n".join(lines).strip()


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

def get_nested(record: dict, field_path: str) -> str:
    """Get a value from a record using dot notation (e.g. 'transcript.text')."""
    parts = field_path.split(".")
    val = record
    for part in parts:
        if not isinstance(val, dict):
            return ""
        val = val.get(part) or ""
    return str(val).strip() if val else ""


def build_prompt(record: dict, title_field: str = "title",
                 text_fields: list[str] | None = None) -> str:
    """Build the Haiku prompt for any source type."""
    if text_fields is None:
        text_fields = ["description"]

    title = record.get(title_field, "").strip()

    # Collect and clean supporting text
    text_parts = []
    for field in text_fields:
        raw = get_nested(record, field)
        if not raw:
            continue
        cleaned = clean_description(raw)
        if len(cleaned) > 600:
            cleaned = cleaned[:600] + "..."
        if cleaned:
            text_parts.append(cleaned)

    content = "\n\n".join(text_parts)

    return f"""你是一位香港時事分析助手。請根據以下YouTube影片資料，用繁體中文完成兩項任務：

1. 撮要：用1至2句話概括影片的核心內容，風格簡潔如新聞標題。可參考標題、簡介及字幕。
2. 關鍵詞：只根據「標題」提取5至8個最重要的繁體中文關鍵詞（人名、地名、事件、議題等），不要從簡介或字幕中提取。

請以下列JSON格式回覆，不要加任何其他文字：
{{
  "summary_zh": "...",
  "keywords_zh": ["...", "...", "..."]
}}

標題：{title}

其他參考資料（只用於撮要，不用於關鍵詞）：
{content}"""


# ---------------------------------------------------------------------------
# Haiku API call
# ---------------------------------------------------------------------------

def call_haiku(client: anthropic.Anthropic, prompt: str) -> dict:
    """
    Call Claude Haiku and parse the JSON response.
    Returns dict with summary_zh and keywords_zh, or error fallback.
    """
    try:
        message = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(
                line for line in lines
                if not line.startswith("```")
            ).strip()

        result = json.loads(raw)

        # Validate expected keys
        if "summary_zh" not in result or "keywords_zh" not in result:
            raise ValueError("Missing expected keys in response")

        # Ensure keywords is a list
        if isinstance(result["keywords_zh"], str):
            result["keywords_zh"] = [result["keywords_zh"]]

        return result

    except json.JSONDecodeError as e:
        log.warning(f"  JSON parse error: {e} | Raw response: {raw[:200]}")
        return {"summary_zh": None, "keywords_zh": [], "processing_error": str(e)}
    except Exception as e:
        log.warning(f"  Haiku API error: {e}")
        return {"summary_zh": None, "keywords_zh": [], "processing_error": str(e)}


# ---------------------------------------------------------------------------
# Data persistence
# ---------------------------------------------------------------------------

def load_raw(date_str: str, raw_dir: Path) -> list[dict]:
    path = raw_dir / f"{date_str}.json"
    if not path.exists():
        log.warning(f"Raw file not found: {path}")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_processed(date_str: str, records: list[dict], processed_dir: Path) -> None:
    processed_dir.mkdir(parents=True, exist_ok=True)
    path = processed_dir / f"{date_str}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    log.info(f"Saved {len(records)} processed records to {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def process_source(source_name: str, client: anthropic.Anthropic,
                   date_str: str, processed_at: str) -> None:
    """Process all raw records for a given source type."""
    cfg = SOURCES[source_name]
    raw_dir = cfg["raw_dir"]
    processed_dir = cfg["processed_dir"]
    title_field = cfg["title_field"]
    text_fields = cfg["text_fields"]

    log.info(f"Processing {source_name} data for {date_str}")
    raw_records = load_raw(date_str, raw_dir)
    if not raw_records:
        log.info(f"No raw records found for {source_name}. Skipping.")
        return

    log.info(f"Found {len(raw_records)} record(s) to process.")
    processed_records = []

    for i, record in enumerate(raw_records):
        item_id = record.get("video_id") or record.get("article_id") or record.get("episode_id", "unknown")
        title = record.get(title_field, "")
        log.info(f"  [{i+1}/{len(raw_records)}] {item_id} — {title[:60]}")

        prompt = build_prompt(record, title_field=title_field, text_fields=text_fields)
        result = call_haiku(client, prompt)

        enriched = {
            **record,
            "summary_zh": result.get("summary_zh"),
            "keywords_zh": result.get("keywords_zh", []),
            "processed_at": processed_at,
        }
        if "processing_error" in result:
            enriched["processing_error"] = result["processing_error"]

        processed_records.append(enriched)

        if i < len(raw_records) - 1:
            time.sleep(RATE_LIMIT_DELAY)

    save_processed(date_str, processed_records, processed_dir)
    log.info(f"Done. {len(processed_records)} {source_name} record(s) processed.")


def main():
    parser = argparse.ArgumentParser(description="Process raw data with Claude Haiku.")
    parser.add_argument(
        "--source",
        choices=["youtube", "news", "podcasts", "all"],
        default="all",
        help="Which source type to process (default: all)",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        log.error("ANTHROPIC_API_KEY environment variable is not set.")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")
    processed_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    sources_to_run = list(SOURCES.keys()) if args.source == "all" else [args.source]

    for source_name in sources_to_run:
        process_source(source_name, client, date_str, processed_at)


if __name__ == "__main__":
    main()
