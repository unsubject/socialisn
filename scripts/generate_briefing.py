"""
generate_briefing.py
Module 4: Sonnet Daily Briefing + Gmail Delivery

Reads today's processed YouTube and news data, uses Claude Sonnet to generate
a thematic briefing in Traditional Chinese, saves it as Markdown, converts to
HTML, and sends via Gmail API.

Run:    python scripts/generate_briefing.py
Env:    ANTHROPIC_API_KEY   — Anthropic API key
        GMAIL_CREDENTIALS   — OAuth2 client credentials JSON (string)
        GMAIL_TOKEN         — OAuth2 token JSON (string)
        RECIPIENT_EMAIL     — destination email address
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import anthropic
import markdown

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
YOUTUBE_PROCESSED_DIR = REPO_ROOT / "data" / "youtube" / "processed"
NEWS_PROCESSED_DIR = REPO_ROOT / "data" / "news" / "processed"
PODCASTS_PROCESSED_DIR = REPO_ROOT / "data" / "podcasts" / "processed"
BRIEFINGS_DIR = REPO_ROOT / "data" / "briefings"

MODEL = "claude-sonnet-4-5-20250514"
MAX_TOKENS = 4096

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_processed(directory: Path, date_str: str) -> list[dict]:
    path = directory / f"{date_str}.json"
    if not path.exists():
        log.warning(f"No processed file found: {path}")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def format_youtube_item(item: dict) -> str:
    """Format a YouTube item for the Sonnet prompt."""
    title = item.get("title", "")
    channel = item.get("channel_name", "")
    summary = item.get("summary_zh", "")
    keywords = "、".join(item.get("keywords_zh", []))
    views = item.get("view_count", 0)
    likes = item.get("like_count", 0)
    duration = item.get("duration_seconds", 0)
    duration_min = duration // 60
    url = f"https://www.youtube.com/watch?v={item.get('video_id', '')}"
    tags = "、".join(item.get("channel_tags", []))

    return (
        f"【YouTube｜{channel}】\n"
        f"標題：{title}\n"
        f"撮要：{summary}\n"
        f"關鍵詞：{keywords}\n"
        f"數據：{views:,} 觀看 / {likes:,} 讚好 / {duration_min} 分鐘\n"
        f"標籤：{tags}\n"
        f"連結：{url}"
    )


def format_news_item(item: dict) -> str:
    """Format a news item for the Sonnet prompt."""
    headline = item.get("headline", "")
    source = item.get("source_name", "")
    summary = item.get("summary_zh", "")
    keywords = "、".join(item.get("keywords_zh", []))
    url = item.get("url", "")
    language = item.get("language", "")
    tags = "、".join(item.get("tags", []))

    return (
        f"【新聞｜{source}】\n"
        f"標題：{headline}\n"
        f"撮要：{summary}\n"
        f"關鍵詞：{keywords}\n"
        f"語言：{language} ／ 標籤：{tags}\n"
        f"連結：{url}"
    )


def format_podcast_item(item: dict) -> str:
    """Format a podcast episode for the Sonnet prompt."""
    title = item.get("title", "")
    podcast = item.get("podcast_name", "")
    summary = item.get("summary_zh", "")
    keywords = "、".join(item.get("keywords_zh", []))
    duration = item.get("duration_seconds", 0)
    duration_min = duration // 60 if duration else 0
    url = item.get("episode_url", "")
    tags = "、".join(item.get("tags", []))

    return (
        f"【Podcast｜{podcast}】\n"
        f"標題：{title}\n"
        f"撮要：{summary}\n"
        f"關鍵詞：{keywords}\n"
        f"數據：{duration_min} 分鐘\n"
        f"標籤：{tags}\n"
        f"連結：{url}"
    )


def build_prompt(youtube_items: list[dict], news_items: list[dict],
                 podcast_items: list[dict], slot: str, date_str: str) -> str:
    """Build the Sonnet briefing prompt."""

    slot_label = "早報" if slot == "morning" else "晚報"
    hkt_date = date_str

    # Sort YouTube by view count descending for prominence
    youtube_sorted = sorted(youtube_items, key=lambda x: x.get("view_count", 0), reverse=True)

    youtube_block = "\n\n".join(format_youtube_item(i) for i in youtube_sorted) if youtube_sorted else "（今日無YouTube資料）"
    news_block = "\n\n".join(format_news_item(i) for i in news_items) if news_items else "（今日無新聞資料）"
    podcast_block = "\n\n".join(format_podcast_item(i) for i in podcast_items) if podcast_items else "（今日無Podcast資料）"

    total_items = len(youtube_items) + len(news_items) + len(podcast_items)

    podcast_section = f"""## 🎙 Podcast（最優先）
以下是來自Podcast的最新內容，請務必在簡報中獨立呈現，不要與其他新聞混合：

{podcast_block}

---""" if podcast_items else ""

    return f"""你是利世民的個人情報助理。請根據以下今日收集的資料，用繁體中文撰寫一份{slot_label}簡報。

日期：{hkt_date}（香港時間）
資料來源數量：共 {total_items} 項（YouTube {len(youtube_items)} 項，新聞 {len(news_items)} 項，Podcast {len(podcast_items)} 項）

---

請按以下格式撰寫，使用Markdown：

# {hkt_date} {slot_label}

{podcast_section}

## 頭條故事
列出今日最重要的 10 個故事。重要性綜合考慮：觀看數字、議題敏感度、時效性。每條頭條包括：
- 一句話標題
- 2至3句分析
- 來源及連結

## 主題分析
將所有項目歸納為 7 個主題（例如：香港政局、中國經濟、國際局勢、社會民生等）。
每個主題下：
- 主題標題
- 2至3句概括該主題今日動態
- 列出相關項目標題及來源

## 數字速覽
- 今日監測項目總數：{total_items}
- YouTube頻道：{len(youtube_items)} 條影片
- 新聞來源：{len(news_items)} 篇文章
- Podcast：{len(podcast_items)} 集
- 最高觀看影片：{youtube_sorted[0].get('title', 'N/A')[:50] if youtube_sorted else 'N/A'}（{youtube_sorted[0].get('view_count', 0):,} 觀看）

## 編輯備注
用2至3句話點出今日整體資訊環境的特點或值得留意之處。

---

以下是今日所有資料：

### 🎙 Podcast（最優先，獨立成節）
{podcast_block}

### YouTube影片
{youtube_block}

### 新聞文章
{news_block}

---
請直接輸出Markdown內容，不要加任何前言或說明。"""


# ---------------------------------------------------------------------------
# Sonnet API call
# ---------------------------------------------------------------------------

def call_sonnet(client: anthropic.Anthropic, prompt: str) -> str:
    """Call Claude Sonnet and return the briefing text."""
    message = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    return message.content[0].text.strip()


# ---------------------------------------------------------------------------
# Gmail sending
# ---------------------------------------------------------------------------

def send_gmail(subject: str, html_body: str) -> None:
    """Send email via Gmail API using OAuth2 credentials from env vars."""
    import base64
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    # Load credentials from environment
    creds_json = os.environ.get("GMAIL_CREDENTIALS", "")
    token_json = os.environ.get("GMAIL_TOKEN", "")
    recipient = os.environ.get("RECIPIENT_EMAIL", "")

    if not creds_json or not token_json or not recipient:
        log.error("Missing Gmail env vars: GMAIL_CREDENTIALS, GMAIL_TOKEN, or RECIPIENT_EMAIL")
        sys.exit(1)

    # Write token to temp file (Google client library needs file path)
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(token_json)
        token_path = f.name

    try:
        creds = Credentials.from_authorized_user_file(token_path)
        service = build("gmail", "v1", credentials=creds)

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["To"] = recipient
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        service.users().messages().send(
            userId="me", body={"raw": raw}
        ).execute()
        log.info(f"Email sent to {recipient}")

    finally:
        Path(token_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# HTML conversion
# ---------------------------------------------------------------------------

def markdown_to_html(md_text: str, title: str) -> str:
    """Convert Markdown briefing to a clean HTML email."""
    body_html = markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "nl2br"]
    )
    return f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{
    font-family: -apple-system, "PingFang HK", "Microsoft JhengHei", sans-serif;
    font-size: 15px;
    line-height: 1.7;
    color: #1a1a1a;
    max-width: 680px;
    margin: 0 auto;
    padding: 24px 16px;
    background: #ffffff;
  }}
  h1 {{ font-size: 22px; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; }}
  h2 {{ font-size: 17px; margin-top: 28px; color: #1a1a1a; border-left: 3px solid #d4a017; padding-left: 10px; }}
  h3 {{ font-size: 15px; margin-top: 16px; color: #333; }}
  p {{ margin: 8px 0; }}
  ul {{ padding-left: 20px; }}
  li {{ margin: 4px 0; }}
  a {{ color: #0066cc; text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  hr {{ border: none; border-top: 1px solid #e0e0e0; margin: 24px 0; }}
  blockquote {{
    border-left: 3px solid #e0e0e0;
    margin: 0;
    padding-left: 12px;
    color: #555;
  }}
  .footer {{
    margin-top: 32px;
    font-size: 12px;
    color: #999;
    border-top: 1px solid #e0e0e0;
    padding-top: 12px;
  }}
</style>
</head>
<body>
{body_html}
<div class="footer">
  由 Socialisn Intelligence Monitor 自動生成 ·
  資料來源：YouTube / RSS新聞 / Podcast
</div>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_briefing(date_str: str, slot: str, content: str) -> Path:
    BRIEFINGS_DIR.mkdir(parents=True, exist_ok=True)
    path = BRIEFINGS_DIR / f"{date_str}-{slot}.md"
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    log.info(f"Briefing saved to {path}")
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        log.error("ANTHROPIC_API_KEY is not set.")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")
    hour_utc = now_utc.hour
    slot = "morning" if hour_utc < 12 else "evening"
    slot_label = "早報" if slot == "morning" else "晚報"

    log.info(f"Generating {slot} briefing for {date_str}")

    # Load processed data
    youtube_items = load_processed(YOUTUBE_PROCESSED_DIR, date_str)
    news_items = load_processed(NEWS_PROCESSED_DIR, date_str)
    podcast_items = load_processed(PODCASTS_PROCESSED_DIR, date_str)

    if not youtube_items and not news_items and not podcast_items:
        log.warning("No processed data found for today. Exiting.")
        sys.exit(0)

    log.info(f"Loaded {len(youtube_items)} YouTube items, {len(news_items)} news items, {len(podcast_items)} podcast items.")

    # Generate briefing
    prompt = build_prompt(youtube_items, news_items, podcast_items, slot, date_str)
    log.info("Calling Sonnet...")
    briefing_md = call_sonnet(client, prompt)

    # Save Markdown
    save_briefing(date_str, slot, briefing_md)

    # Convert to HTML and send
    subject = f"【情報簡報】{date_str} {slot_label}"
    html = markdown_to_html(briefing_md, subject)

    log.info("Sending email...")
    send_gmail(subject, html)
    log.info("Done.")


if __name__ == "__main__":
    main()
