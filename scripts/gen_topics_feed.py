import os, json, glob
from datetime import datetime, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
TOPICS_DIR = os.path.join(BASE_DIR, 'data', 'topics')
OUT_PATH = os.path.join(BASE_DIR, 'docs', 'topics-feed.xml')

TITLE = "節目主題候選 Content Topic Candidates"
LINK = "https://unsubject.github.io/socialisn/topics-feed.xml"
DESC = "利世民節目內容準備——每日主題候選，每日兩次更新"
LANG = "zh-TW"


def load_entries():
    files = sorted(glob.glob(os.path.join(TOPICS_DIR, '*.json')), reverse=True)
    items = []
    for fp in files:
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                data = json.load(f)
            date = data.get('date')
            period = data.get('period')
            gen_at = data.get('generated_at')
            if not (date and period and gen_at):
                continue
            items.append((date, period, gen_at, data))
        except Exception:
            continue
    # sort by date+period+generated_at descending
    def key(t):
        date, period, gen_at, _ = t
        per = 0 if period == 'evening' else 1
        return (date, per, gen_at)
    items.sort(key=key, reverse=True)
    return items[:30]


def topics_html(topics):
    parts = ["<div>"]
    for t in topics:
        parts.append(f"<h3>{escape(str(t.get('id')))}. {escape(t.get('headline',''))}</h3>")
        parts.append(f"<p><strong>Why it matters:</strong> {escape(t.get('why_it_matters',''))}</p>")
        parts.append(f"<p><strong>Competitor status:</strong> {escape(t.get('competitor_status',''))}</p>")
        parts.append(f"<p><strong>Simon’s angle:</strong> {escape(t.get('simons_angle',''))}</p>")
        srcs = t.get('sources') or []
        if srcs:
            parts.append("<ul>")
            for s in srcs:
                title = escape(s.get('title',''))
                url = escape(s.get('url',''))
                parts.append(f"<li><a href=\"{url}\">{title}</a></li>")
            parts.append("</ul>")
    parts.append("</div>")
    return "\n".join(parts)


def main():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    entries = load_entries()
    now = datetime.now(timezone.utc)

    channel_pub = format_datetime(now)

    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<rss version="2.0">')
    out.append('<channel>')
    out.append(f'<title>{escape(TITLE)}</title>')
    out.append(f'<link>{escape(LINK)}</link>')
    out.append(f'<description>{escape(DESC)}</description>')
    out.append(f'<language>{escape(LANG)}</language>')
    out.append(f'<lastBuildDate>{escape(channel_pub)}</lastBuildDate>')

    for date, period, gen_at, data in entries:
        topics = data.get('topics') or []
        top_headline = topics[0].get('headline') if topics else ''
        item_title = f"{date} {period} — Top: {top_headline}"
        item_link = f"{LINK}#{date}-{period}"
        guid = f"topics-{date}-{period}"

        try:
            pub_dt = datetime.fromisoformat(gen_at.replace('Z', '+00:00'))
        except Exception:
            pub_dt = now

        pub_date = format_datetime(pub_dt)
        desc_html = topics_html(topics)

        out.append('<item>')
        out.append(f'<title>{escape(item_title)}</title>')
        out.append(f'<link>{escape(item_link)}</link>')
        out.append(f'<guid isPermaLink="false">{escape(guid)}</guid>')
        out.append(f'<pubDate>{escape(pub_date)}</pubDate>')
        out.append(f'<description><![CDATA[{desc_html}]]></description>')
        out.append('</item>')

    out.append('</channel>')
    out.append('</rss>')

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write("\n".join(out) + "\n")


if __name__ == '__main__':
    main()
