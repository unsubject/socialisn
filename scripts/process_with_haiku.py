"""
process_with_haiku.py
Module 3: Haiku Processing Layer

Reads today's raw YouTube data, sends each video's title + description +
transcript (if available) to Claude Haiku, and generates:
  - summary_zh: 1–2 sentence Traditional Chinese summary (headline style)
  - keywords_zh: 5–8 Traditional Chinese keywords

Output: data/youtube/processed/YYYY-MM-DD.json
        (full raw record + summary_zh + keywords_zh + processed_at)

Run:    python scripts/process_with_haiku.py
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

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DATA_DIR = REPO_ROOT / "data" / "youtube" / "raw"
PROCESSED_DATA_DIR = REPO_ROOT / "data" / "youtube" / "processed"

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

def build_prompt(video: dict) -> str:
    """Build the prompt text for a single video."""
    title = video.get("title", "").strip()
    description = clean_description((video.get("description", "") or ""))
    transcript_data = video.get("transcript", {}) or {}
    transcript_text = (transcript_data.get("text") or "").strip()

    # Truncate cleaned description at 600 chars
    if len(description) > 600:
        description = description[:600] + "..."

    # Transcript can be long — cap at 2000 chars
    if len(transcript_text) > 2000:
        transcript_text = transcript_text[:2000] + "..."

    parts = [f"標題：{title}"]

    if description:
        parts.append(f"簡介：{description}")

    if transcript_text:
        parts.append(f"字幕節錄：{transcript_text}")

    content = "\n\n".join(parts)

    return f"""你是一位香港時事分析助手。請根據以下YouTube影片資料，用繁體中文完成兩項任務：

1. 撮要：用1至2句話概括影片的核心內容，風格簡潔如新聞標題。
2. 關鍵詞：提取5至8個最重要的繁體中文關鍵詞（人名、地名、事件、議題等）。

請以下列JSON格式回覆，不要加任何其他文字：
{{
  "summary_zh": "...",
  "keywords_zh": ["...", "...", "..."]
}}

影片資料：
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

def load_raw(date_str: str) -> list[dict]:
    path = RAW_DATA_DIR / f"{date_str}.json"
    if not path.exists():
        log.warning(f"Raw file not found: {path}")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_processed(date_str: str, records: list[dict]) -> None:
    PROCESSED_DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = PROCESSED_DATA_DIR / f"{date_str}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    log.info(f"Saved {len(records)} processed records to {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        log.error("ANTHROPIC_API_KEY environment variable is not set.")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")
    processed_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    log.info(f"Processing raw YouTube data for {date_str}")

    raw_records = load_raw(date_str)
    if not raw_records:
        log.info("No raw records to process. Exiting.")
        return

    log.info(f"Found {len(raw_records)} video(s) to process.")

    processed_records = []

    for i, video in enumerate(raw_records):
        video_id = video.get("video_id", "unknown")
        title = video.get("title", "")
        log.info(f"  [{i+1}/{len(raw_records)}] Processing: {video_id} — {title[:60]}")

        prompt = build_prompt(video)
        result = call_haiku(client, prompt)

        enriched = {
            **video,
            "summary_zh": result.get("summary_zh"),
            "keywords_zh": result.get("keywords_zh", []),
            "processed_at": processed_at,
        }
        if "processing_error" in result:
            enriched["processing_error"] = result["processing_error"]

        processed_records.append(enriched)

        if i < len(raw_records) - 1:
            time.sleep(RATE_LIMIT_DELAY)

    save_processed(date_str, processed_records)
    log.info(f"Done. {len(processed_records)} video(s) processed.")


if __name__ == "__main__":
    main()
