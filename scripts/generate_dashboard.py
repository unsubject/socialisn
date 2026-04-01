"""
generate_dashboard.py
Module 5b: Static React Dashboard Generator

Reads today's processed data and all briefings, generates:
  docs/index.html              — React dashboard (self-contained)
  docs/briefings/YYYY-MM-DD-{slot}.html — Individual briefing pages

Run:    python scripts/generate_dashboard.py
"""

import json
import logging
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import markdown

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
YOUTUBE_PROCESSED_DIR = REPO_ROOT / "data" / "youtube" / "processed"
NEWS_PROCESSED_DIR = REPO_ROOT / "data" / "news" / "processed"
BRIEFINGS_DIR = REPO_ROOT / "data" / "briefings"
DOCS_DIR = REPO_ROOT / "docs"
BRIEFING_PAGES_DIR = DOCS_DIR / "briefings"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def load_json(path: Path) -> list:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_today(directory: Path) -> list:
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return load_json(directory / f"{date_str}.json")


def get_keyword_counts(youtube: list, news: list) -> list:
    """Aggregate all keywords across all items, return sorted by frequency."""
    counter = Counter()
    for item in youtube + news:
        for kw in item.get("keywords_zh", []):
            if kw:
                counter[kw.strip()] += 1
    return [{"word": w, "count": c} for w, c in counter.most_common(40)]


def get_channel_counts(youtube: list) -> list:
    """Count videos per channel."""
    counter = Counter()
    for item in youtube:
        ch = item.get("channel_name", "Unknown")
        counter[ch] += 1
    return [{"channel": ch, "count": c} for ch, c in counter.most_common(15)]


def get_briefing_archive() -> list:
    """Load all briefings sorted newest first."""
    entries = []
    for path in sorted(BRIEFINGS_DIR.glob("*.md"), reverse=True):
        match = re.match(r"(\d{4}-\d{2}-\d{2})-(morning|evening)", path.stem)
        if not match:
            continue
        date_str, slot = match.group(1), match.group(2)
        slot_label = "早報" if slot == "morning" else "晚報"
        entries.append({
            "date": date_str,
            "slot": slot,
            "label": f"{date_str} {slot_label}",
            "file": path.stem,
        })
    return entries[:30]


def load_latest_briefing() -> str:
    """Return HTML of the most recent briefing."""
    files = sorted(BRIEFINGS_DIR.glob("*.md"), reverse=True)
    if not files:
        return "<p>尚無簡報</p>"
    md_text = files[0].read_text(encoding="utf-8")
    return markdown.markdown(md_text, extensions=["tables", "fenced_code", "nl2br"])


# ---------------------------------------------------------------------------
# Individual briefing pages
# ---------------------------------------------------------------------------

def generate_briefing_pages():
    BRIEFING_PAGES_DIR.mkdir(parents=True, exist_ok=True)
    for path in BRIEFINGS_DIR.glob("*.md"):
        match = re.match(r"(\d{4}-\d{2}-\d{2})-(morning|evening)", path.stem)
        if not match:
            continue
        date_str, slot = match.group(1), match.group(2)
        slot_label = "早報" if slot == "morning" else "晚報"
        md_text = path.read_text(encoding="utf-8")
        body_html = markdown.markdown(md_text, extensions=["tables", "fenced_code", "nl2br"])

        html = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>【情報簡報】{date_str} {slot_label}</title>
<style>
  body {{
    font-family: -apple-system, "PingFang HK", "Microsoft JhengHei", sans-serif;
    font-size: 15px; line-height: 1.8; color: #1a1a1a;
    max-width: 720px; margin: 0 auto; padding: 32px 16px;
  }}
  h1 {{ font-size: 22px; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; }}
  h2 {{ font-size: 17px; margin-top: 28px; border-left: 3px solid #d4a017; padding-left: 10px; }}
  a {{ color: #0066cc; }} a:hover {{ text-decoration: underline; }}
  .back {{ margin-bottom: 24px; }}
  .back a {{ font-size: 13px; color: #666; }}
</style>
</head>
<body>
<div class="back"><a href="../index.html">← 返回主頁</a></div>
{body_html}
</body>
</html>"""
        out_path = BRIEFING_PAGES_DIR / f"{path.stem}.html"
        out_path.write_text(html, encoding="utf-8")
    log.info(f"Briefing pages generated in {BRIEFING_PAGES_DIR}")


# ---------------------------------------------------------------------------
# Dashboard HTML
# ---------------------------------------------------------------------------

def generate_dashboard(youtube: list, news: list):
    keywords = get_keyword_counts(youtube, news)
    channels = get_channel_counts(youtube)
    archive = get_briefing_archive()
    latest_briefing_html = load_latest_briefing()

    # Prepare data for React
    keywords_json = json.dumps(keywords, ensure_ascii=False)
    channels_json = json.dumps(channels, ensure_ascii=False)
    archive_json = json.dumps(archive, ensure_ascii=False)
    latest_html_json = json.dumps(latest_briefing_html, ensure_ascii=False)

    # Top YouTube items by views
    top_youtube = sorted(youtube, key=lambda x: x.get("view_count", 0), reverse=True)[:10]
    top_youtube_json = json.dumps([{
        "title": i.get("title", ""),
        "channel": i.get("channel_name", ""),
        "views": i.get("view_count", 0),
        "summary": i.get("summary_zh", ""),
        "url": f"https://www.youtube.com/watch?v={i.get('video_id', '')}",
    } for i in top_youtube], ensure_ascii=False)

    # News items
    news_json = json.dumps([{
        "headline": i.get("headline", ""),
        "source": i.get("source_name", ""),
        "summary": i.get("summary_zh", ""),
        "url": i.get("url", ""),
        "language": i.get("language", ""),
        "tags": i.get("tags", []),
    } for i in news[:20]], ensure_ascii=False)

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    total = len(youtube) + len(news)

    html = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>情報簡報 Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/recharts/2.15.3/Recharts.min.js"></script>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, "PingFang HK", "Microsoft JhengHei", sans-serif;
    background: #f5f5f0; color: #1a1a1a; font-size: 14px;
  }}
  #root {{ min-height: 100vh; }}
</style>
</head>
<body>
<div id="root"></div>
<script>
const {{ useState, useEffect }} = React;
const {{ BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell }} = Recharts;

const DATA = {{
  keywords: {keywords_json},
  channels: {channels_json},
  archive: {archive_json},
  latestBriefing: {latest_html_json},
  topYoutube: {top_youtube_json},
  news: {news_json},
  updatedAt: "{now_str}",
  totalItems: {total},
  youtubeCount: {len(youtube)},
  newsCount: {len(news)},
}};

const COLORS = ["#d4a017","#2d6a9f","#c0392b","#27ae60","#8e44ad",
                 "#e67e22","#16a085","#2c3e50","#d35400","#1abc9c"];

function Header() {{
  return React.createElement("header", {{
    style: {{ background: "#1a1a1a", color: "#fff", padding: "16px 24px",
              display: "flex", justifyContent: "space-between", alignItems: "center" }}
  }},
    React.createElement("div", null,
      React.createElement("h1", {{ style: {{ fontSize: "18px", fontWeight: 700 }} }}, "情報簡報"),
      React.createElement("p", {{ style: {{ fontSize: "11px", color: "#999", marginTop: "2px" }} }},
        "Intelligence Monitor Dashboard")
    ),
    React.createElement("div", {{ style: {{ textAlign: "right", fontSize: "11px", color: "#aaa" }} }},
      React.createElement("div", null, `更新：${{DATA.updatedAt}}`),
      React.createElement("div", null, `今日監測：${{DATA.totalItems}} 項`)
    )
  );
}}

function StatCard({{ label, value, sub }}) {{
  return React.createElement("div", {{
    style: {{ background: "#fff", borderRadius: "8px", padding: "16px 20px",
              flex: 1, minWidth: "140px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}
  }},
    React.createElement("div", {{ style: {{ fontSize: "24px", fontWeight: 700, color: "#d4a017" }} }}, value),
    React.createElement("div", {{ style: {{ fontSize: "13px", color: "#555", marginTop: "4px" }} }}, label),
    sub && React.createElement("div", {{ style: {{ fontSize: "11px", color: "#999", marginTop: "2px" }} }}, sub)
  );
}}

function KeywordCloud({{ keywords }}) {{
  if (!keywords.length) return React.createElement("p", {{ style: {{ color: "#999" }} }}, "暫無數據");
  const max = keywords[0].count;
  return React.createElement("div", {{ style: {{ display: "flex", flexWrap: "wrap", gap: "8px" }} }},
    keywords.map((k, i) => {{
      const size = 12 + Math.round((k.count / max) * 14);
      const opacity = 0.5 + (k.count / max) * 0.5;
      return React.createElement("span", {{
        key: k.word,
        style: {{
          fontSize: `${{size}}px`, color: COLORS[i % COLORS.length],
          opacity, fontWeight: k.count > 1 ? 600 : 400,
          cursor: "default", lineHeight: 1.4,
        }},
        title: `出現 ${{k.count}} 次`
      }}, k.word);
    }})
  );
}}

function ChannelChart({{ channels }}) {{
  if (!channels.length) return React.createElement("p", {{ style: {{ color: "#999" }} }}, "暫無數據");
  const max = Math.max(...channels.map(c => c.count));
  return React.createElement("div", {{ style: {{ display: "flex", flexDirection: "column", gap: "8px" }} }},
    channels.map((c, i) =>
      React.createElement("div", {{ key: i, style: {{ display: "flex", alignItems: "center", gap: "8px" }} }},
        React.createElement("div", {{
          style: {{ width: "120px", fontSize: "11px", textAlign: "right",
                    color: "#555", flexShrink: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        }}, c.channel),
        React.createElement("div", {{
          style: {{ flex: 1, background: "#f0f0f0", borderRadius: "3px", height: "20px", position: "relative" }}
        }},
          React.createElement("div", {{
            style: {{
              width: `${{Math.round((c.count / max) * 100)}}%`,
              background: COLORS[i % COLORS.length],
              height: "100%", borderRadius: "3px",
              display: "flex", alignItems: "center", paddingLeft: "6px",
              minWidth: "24px",
            }}
          }},
            React.createElement("span", {{ style: {{ fontSize: "10px", color: "#fff", fontWeight: 600 }} }}, c.count)
          )
        )
      )
    )
  );
}}

function YoutubeList({{ items }}) {{
  if (!items.length) return React.createElement("p", {{ style: {{ color: "#999" }} }}, "暫無數據");
  return React.createElement("div", {{ style: {{ display: "flex", flexDirection: "column", gap: "12px" }} }},
    items.map((item, i) =>
      React.createElement("div", {{
        key: i,
        style: {{ background: "#fff", borderRadius: "8px", padding: "12px 16px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
      }},
        React.createElement("div", {{ style: {{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }} }},
          React.createElement("a", {{
            href: item.url, target: "_blank", rel: "noopener",
            style: {{ fontSize: "13px", fontWeight: 600, color: "#1a1a1a",
                      textDecoration: "none", lineHeight: 1.4, flex: 1 }}
          }}, item.title),
          React.createElement("span", {{
            style: {{ fontSize: "11px", color: "#999", whiteSpace: "nowrap" }}
          }}, `${{item.views.toLocaleString()}} 觀看`)
        ),
        React.createElement("div", {{ style: {{ fontSize: "11px", color: "#d4a017", marginTop: "4px" }} }}, item.channel),
        item.summary && React.createElement("p", {{
          style: {{ fontSize: "12px", color: "#555", marginTop: "6px", lineHeight: 1.5 }}
        }}, item.summary)
      )
    )
  );
}}

function NewsList({{ items }}) {{
  if (!items.length) return React.createElement("p", {{ style: {{ color: "#999" }} }}, "暫無數據");
  return React.createElement("div", {{ style: {{ display: "flex", flexDirection: "column", gap: "10px" }} }},
    items.map((item, i) =>
      React.createElement("div", {{
        key: i,
        style: {{ background: "#fff", borderRadius: "8px", padding: "12px 16px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
      }},
        React.createElement("div", {{ style: {{ display: "flex", justifyContent: "space-between", gap: "8px" }} }},
          React.createElement("a", {{
            href: item.url, target: "_blank", rel: "noopener",
            style: {{ fontSize: "13px", fontWeight: 600, color: "#1a1a1a",
                      textDecoration: "none", flex: 1, lineHeight: 1.4 }}
          }}, item.headline),
          React.createElement("span", {{
            style: {{ fontSize: "11px", color: "#2d6a9f", whiteSpace: "nowrap" }}
          }}, item.source)
        ),
        item.summary && React.createElement("p", {{
          style: {{ fontSize: "12px", color: "#555", marginTop: "6px", lineHeight: 1.5 }}
        }}, item.summary)
      )
    )
  );
}}

function BriefingArchive({{ archive }}) {{
  if (!archive.length) return React.createElement("p", {{ style: {{ color: "#999" }} }}, "暫無簡報");
  return React.createElement("div", {{ style: {{ display: "flex", flexDirection: "column", gap: "6px" }} }},
    archive.map((entry, i) =>
      React.createElement("a", {{
        key: i,
        href: `briefings/${{entry.file}}.html`,
        style: {{ fontSize: "13px", color: "#0066cc", textDecoration: "none",
                  padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}
      }}, `【情報簡報】${{entry.label}}`)
    )
  );
}}

function Section({{ title, children, rssLink }}) {{
  return React.createElement("div", {{
    style: {{ background: "#fff", borderRadius: "8px", padding: "20px 24px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
  }},
    React.createElement("div", {{
      style: {{ display: "flex", justifyContent: "space-between", alignItems: "center",
                marginBottom: "16px" }}
    }},
      React.createElement("h2", {{
        style: {{ fontSize: "15px", fontWeight: 700,
                  borderLeft: "3px solid #d4a017", paddingLeft: "10px" }}
      }}, title),
      rssLink && React.createElement("a", {{
        href: "feed.xml", style: {{ fontSize: "11px", color: "#d4a017" }}
      }}, "RSS ↗")
    ),
    children
  );
}}

function LatestBriefing({{ html }}) {{
  return React.createElement("div", {{
    dangerouslySetInnerHTML: {{ __html: html }},
    style: {{
      fontSize: "13px", lineHeight: 1.8, color: "#1a1a1a",
      maxHeight: "600px", overflowY: "auto",
    }}
  }});
}}

function App() {{
  const [tab, setTab] = useState("briefing");
  const tabs = [
    {{ id: "briefing", label: "最新簡報" }},
    {{ id: "youtube", label: "YouTube" }},
    {{ id: "news", label: "新聞" }},
    {{ id: "keywords", label: "關鍵詞" }},
    {{ id: "archive", label: "簡報存檔" }},
  ];

  return React.createElement("div", null,
    React.createElement(Header),
    React.createElement("div", {{
      style: {{ display: "flex", gap: "12px", padding: "16px 24px 0",
                flexWrap: "wrap" }}
    }},
      React.createElement(StatCard, {{ label: "今日監測項目", value: DATA.totalItems }}),
      React.createElement(StatCard, {{ label: "YouTube影片", value: DATA.youtubeCount }}),
      React.createElement(StatCard, {{ label: "新聞文章", value: DATA.newsCount }}),
      React.createElement(StatCard, {{ label: "關鍵詞", value: DATA.keywords.length }}),
    ),
    React.createElement("div", {{
      style: {{ display: "flex", gap: "4px", padding: "16px 24px 0", borderBottom: "1px solid #e0e0e0" }}
    }},
      tabs.map(t => React.createElement("button", {{
        key: t.id,
        onClick: () => setTab(t.id),
        style: {{
          padding: "8px 16px", fontSize: "13px", fontWeight: tab === t.id ? 700 : 400,
          background: tab === t.id ? "#1a1a1a" : "transparent",
          color: tab === t.id ? "#fff" : "#555",
          border: "none", borderRadius: "4px 4px 0 0", cursor: "pointer",
        }}
      }}, t.label))
    ),
    React.createElement("div", {{ style: {{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }} }},
      tab === "briefing" && React.createElement(Section, {{ title: "最新簡報", rssLink: true }},
        React.createElement(LatestBriefing, {{ html: DATA.latestBriefing }})
      ),
      tab === "youtube" && React.createElement("div", {{ style: {{ display: "flex", flexDirection: "column", gap: "16px" }} }},
        React.createElement(Section, {{ title: "頻道活躍度" }},
          React.createElement(ChannelChart, {{ channels: DATA.channels }})
        ),
        React.createElement(Section, {{ title: "熱門影片（按觀看數）" }},
          React.createElement(YoutubeList, {{ items: DATA.topYoutube }})
        )
      ),
      tab === "news" && React.createElement(Section, {{ title: "今日新聞" }},
        React.createElement(NewsList, {{ items: DATA.news }})
      ),
      tab === "keywords" && React.createElement(Section, {{ title: "今日關鍵詞雲" }},
        React.createElement(KeywordCloud, {{ keywords: DATA.keywords }})
      ),
      tab === "archive" && React.createElement(Section, {{ title: "簡報存檔", rssLink: true }},
        React.createElement(BriefingArchive, {{ archive: DATA.archive }})
      )
    )
  );
}}

// Error boundary for debugging
class ErrorBoundary extends React.Component {{
  constructor(props) {{ super(props); this.state = {{ error: null }}; }}
  static getDerivedStateFromError(e) {{ return {{ error: e }}; }}
  render() {{
    if (this.state.error) {{
      return React.createElement("div", {{
        style: {{ padding: "32px", fontFamily: "monospace", color: "red" }}
      }}, "React error: " + this.state.error.toString());
    }}
    return this.props.children;
  }}
}}

ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(ErrorBoundary, null, React.createElement(App))
);
</script>
</body>
</html>"""

    out_path = DOCS_DIR / "index.html"
    out_path.write_text(html, encoding="utf-8")
    log.info(f"Dashboard written to {out_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    youtube = load_today(YOUTUBE_PROCESSED_DIR)
    news = load_today(NEWS_PROCESSED_DIR)
    log.info(f"Loaded {len(youtube)} YouTube items, {len(news)} news items.")
    generate_briefing_pages()
    generate_dashboard(youtube, news)
    log.info("Dashboard generation complete.")


if __name__ == "__main__":
    main()
