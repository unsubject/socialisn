import os, json, glob
from datetime import datetime, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TOPICS_DIR = os.path.join(ROOT, 'data', 'topics')
OUT_PATH = os.path.join(ROOT, 'docs', 'topics-feed.xml')

TITLE = '節目主題候選 Content Topic Candidates'
LINK = 'https://unsubject.github.io/socialisn/topics-feed.xml'
DESC = '利世民節目內容準備——每日主題候選，每日兩次更新'
LANG = 'zh-TW'


def load_entries():
    files = sorted(glob.glob(os.path.join(TOPICS_DIR, '*.json')), reverse=True)
    entries = []
    for fp in files:
        with open(fp, 'r', encoding='utf-8') as f:
            obj = json.load(f)
        entries.append(obj)
    # sort by date desc then period (evening first)
    def key(o):
        return (o.get('date',''), 1 if o.get('period') == 'evening' else 0)
    entries.sort(key=key, reverse=True)
    return entries[:30]


def html_for_topics(topics):
    parts = ['<div>']
    for t in topics:
        parts.append(f"<h3>{escape(str(t.get('id')))}. {escape(t.get('headline',''))}</h3>")
        parts.append(f"<p><strong>Why it matters:</strong> {escape(t.get('why_it_matters',''))}</p>")
        parts.append(f"<p><strong>Competitor status:</strong> {escape(t.get('competitor_status',''))}</p>")
        parts.append(f"<p><strong>Simon\'s angle:</strong> {escape(t.get('simons_angle',''))}</p>")
        srcs = t.get('sources', []) or []
        if srcs:
            parts.append('<ul>')
            for s in srcs:
                title = escape(s.get('title',''))
                url = escape(s.get('url',''))
                parts.append(f'<li><a href="{url}">{title}</a></li>')
            parts.append('</ul>')
    parts.append('</div>')
    return '\n'.join(parts)


def main():
    entries = load_entries()
    now = datetime.now(timezone.utc)

    items_xml = []
    for e in entries:
        date = e.get('date')
        period = e.get('period')
        topics = e.get('topics', [])
        top_headline = topics[0]['headline'] if topics else ''
        guid = f"topics-{date}-{period}"
        pub_dt = now
        # if generated_at present use it
        ga = e.get('generated_at')
        if ga:
            try:
                pub_dt = datetime.fromisoformat(ga.replace('Z','+00:00'))
            except Exception:
                pub_dt = now

        desc_html = html_for_topics(topics)
        items_xml.append(
            "\n".join([
                "<item>",
                f"<title>{escape(date)} {escape(period)} — Top: {escape(top_headline)}</title>",
                f"<link>{LINK}#{escape(date)}-{escape(period)}</link>",
                f"<guid isPermaLink=\"false\">{escape(guid)}</guid>",
                f"<pubDate>{escape(format_datetime(pub_dt))}</pubDate>",
                f"<description><![CDATA[{desc_html}]]></description>",
                "</item>",
            ])
        )

    rss = "\n".join([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<rss version=\"2.0\">",
        "<channel>",
        f"<title>{escape(TITLE)}</title>",
        f"<link>{escape(LINK)}</link>",
        f"<description>{escape(DESC)}</description>",
        f"<language>{escape(LANG)}</language>",
        f"<lastBuildDate>{escape(format_datetime(now))}</lastBuildDate>",
        "\n".join(items_xml),
        "</channel>",
        "</rss>",
        "",
    ])

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write(rss)


if __name__ == '__main__':
    main()
