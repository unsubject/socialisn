const SLOT_LABELS = { morning: '早報', midday: '午報', evening: '晚報' };

const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang HK', 'Microsoft JhengHei', sans-serif;
    max-width: 1040px; margin: 0 auto; padding: 24px 16px;
    line-height: 1.7; color: #1a1a1a; background: #fafafa;
  }
  nav { display: flex; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid #e0e0e0; }
  nav a { color: #333; text-decoration: none; font-weight: 500; }
  nav a:hover { color: #0066cc; }
  .wrap { display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 32px; margin-top: 24px; }
  @media (max-width: 760px) { .wrap { grid-template-columns: 1fr; } aside { order: 2; } }
  main { background: #fff; padding: 24px; border-radius: 8px; min-width: 0; }
  aside { font-size: 14px; }
  aside h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-top: 0; }
  aside ul { list-style: none; padding: 0; margin: 0; }
  aside li { margin: 6px 0; }
  aside a { color: #333; text-decoration: none; }
  aside a:hover { color: #0066cc; }
  main h1 { font-size: 22px; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-top: 0; }
  main h2 { font-size: 17px; margin-top: 28px; border-left: 3px solid #d4a017; padding-left: 10px; }
  main h3 { font-size: 15px; margin-top: 16px; color: #333; }
  main p { margin: 8px 0; }
  main ul { padding-left: 20px; }
  main a { color: #0066cc; text-decoration: none; }
  main a:hover { text-decoration: underline; }
  .meta { color: #666; font-size: 13px; margin-bottom: 16px; }
  .archive-table { width: 100%; border-collapse: collapse; }
  .archive-table td, .archive-table th { padding: 8px; border-bottom: 1px solid #e0e0e0; text-align: left; }
  .pagination { margin-top: 24px; display: flex; gap: 8px; flex-wrap: wrap; }
  .pagination a, .pagination span { padding: 6px 12px; border: 1px solid #e0e0e0; border-radius: 4px; text-decoration: none; color: #333; }
  .pagination .current { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  footer { margin-top: 32px; font-size: 12px; color: #999; border-top: 1px solid #e0e0e0; padding-top: 12px; text-align: center; }
`;

function slotLabel(slot) {
  return SLOT_LABELS[slot] ?? slot;
}

function fmtGeneratedAt(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function layout({ title, sidebar, body }) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escape(title)}</title>
  <link rel="alternate" type="application/rss+xml" title="Socialisn Briefings" href="/feed.xml">
  <style>${CSS}</style>
</head>
<body>
  <nav>
    <a href="/">最新</a>
    <a href="/archive">存檔</a>
    <a href="/feed.xml">RSS</a>
  </nav>
  <div class="wrap">
    <main>${body}</main>
    <aside>${sidebar}</aside>
  </div>
  <footer>Socialisn Intelligence Monitor</footer>
</body>
</html>`;
}

export function renderSidebar(recent) {
  if (!recent?.length) return '<h3>最近簡報</h3><p style="color:#999">暫無</p>';
  const items = recent
    .map(
      (r) =>
        `<li><a href="/b/${escape(r.date)}/${escape(r.slot)}">${escape(r.date)} · ${escape(slotLabel(r.slot))}</a></li>`
    )
    .join('');
  return `<h3>最近簡報</h3><ul>${items}</ul>`;
}

export function renderBriefing(b) {
  const title = `${b.date} ${slotLabel(b.slot)} · Socialisn Briefings`;
  const meta = `<div class="meta">${escape(String(b.date))} · ${escape(slotLabel(b.slot))} · 生成於 ${escape(fmtGeneratedAt(b.generated_at))}</div>`;
  const body = b.html || `<pre>${escape(b.markdown || '')}</pre>`;
  return { title, body: meta + body };
}

export function renderArchive({ rows, total, page, pageSize }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = rows
    .map(
      (r) =>
        `<tr><td><a href="/b/${escape(r.date)}/${escape(r.slot)}">${escape(r.date)} · ${escape(slotLabel(r.slot))}</a></td><td style="color:#999">${escape(fmtGeneratedAt(r.generated_at))}</td></tr>`
    )
    .join('');
  const pager = [];
  for (let p = 1; p <= pages; p++) {
    pager.push(
      p === page
        ? `<span class="current">${p}</span>`
        : `<a href="/archive?page=${p}">${p}</a>`
    );
  }
  return `
    <h1>存檔 · 共 ${total} 篇</h1>
    <table class="archive-table"><tbody>${items}</tbody></table>
    <div class="pagination">${pager.join('')}</div>
  `;
}

export function renderFeed(items, siteUrl) {
  const xmlItems = items
    .map((b) => {
      const link = `${siteUrl}/b/${b.date}/${b.slot}`;
      const title = `${b.date} ${slotLabel(b.slot)}`;
      const description = (b.markdown || '').slice(0, 400);
      const pubDate = new Date(b.generated_at).toUTCString();
      return `
    <item>
      <title>${escape(title)}</title>
      <link>${escape(link)}</link>
      <guid isPermaLink="true">${escape(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escape(description)}</description>
    </item>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Socialisn Briefings</title>
    <link>${escape(siteUrl)}</link>
    <description>每日情報簡報 · morning / midday / evening</description>
    <language>zh-Hant</language>${xmlItems}
  </channel>
</rss>`;
}
