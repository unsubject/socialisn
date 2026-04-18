import { workflow, node, trigger, newCredential, expr, placeholder } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 23:30 UTC',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '30 23 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchItems = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Today Items',
    parameters: {
      operation: 'executeQuery',
      query: [
        "SELECT",
        "  COALESCE((SELECT json_agg(sub) FROM (",
        "    SELECT y.video_id, y.channel_name, y.channel_tags, y.title,",
        "           y.view_count, y.like_count, y.duration_seconds,",
        "           e.summary_zh, e.keywords_zh",
        "    FROM youtube_items y",
        "    LEFT JOIN item_enrichment e ON e.item_type = 'youtube' AND e.item_id = y.video_id",
        "    WHERE y.fetched_at >= CURRENT_DATE - interval '2 days'",
        "    ORDER BY y.view_count DESC",
        "  ) sub), '[]'::json) as youtube_items,",
        "  COALESCE((SELECT json_agg(sub) FROM (",
        "    SELECT n.article_id, n.source_name, n.headline, n.url, n.language, n.tags,",
        "           e.summary_zh, e.keywords_zh",
        "    FROM news_items n",
        "    LEFT JOIN item_enrichment e ON e.item_type = 'news' AND e.item_id = n.article_id",
        "    WHERE n.fetched_at >= CURRENT_DATE - interval '2 days'",
        "    ORDER BY n.published_at DESC",
        "  ) sub), '[]'::json) as news_items,",
        "  COALESCE((SELECT json_agg(sub) FROM (",
        "    SELECT p.episode_id, p.podcast_name, p.podcast_tags, p.title,",
        "           p.episode_url, p.duration_seconds,",
        "           e.summary_zh, e.keywords_zh",
        "    FROM podcast_items p",
        "    LEFT JOIN item_enrichment e ON e.item_type = 'podcast' AND e.item_id = p.episode_id",
        "    WHERE p.fetched_at >= CURRENT_DATE - interval '2 days'",
        "    ORDER BY p.published_at DESC",
        "  ) sub), '[]'::json) as podcast_items",
      ].join('\n'),
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [{ youtube_items: [], news_items: [], podcast_items: [] }]
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Briefing Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        "const row = $input.first().json;",
        "const yt = Array.isArray(row.youtube_items) ? row.youtube_items : [];",
        "const news = Array.isArray(row.news_items) ? row.news_items : [];",
        "const pods = Array.isArray(row.podcast_items) ? row.podcast_items : [];",
        "",
        "const now = new Date();",
        "const dateStr = now.toISOString().split('T')[0];",
        "const slot = now.getUTCHours() < 12 ? 'morning' : 'evening';",
        "const slotLabel = slot === 'morning' ? '早報' : '晚報';",
        "const total = yt.length + news.length + pods.length;",
        "",
        "function fmtYt(i) {",
        "  const kw = (i.keywords_zh || []).join('、');",
        "  const tags = (i.channel_tags || []).join('、');",
        "  return '【YouTube｜' + (i.channel_name||'') + '】\\n'",
        "    + '標題：' + (i.title||'') + '\\n'",
        "    + '撮要：' + (i.summary_zh||'') + '\\n'",
        "    + '關鍵詞：' + kw + '\\n'",
        "    + '數據：' + (i.view_count||0).toLocaleString() + ' 觀看 / '",
        "    + (i.like_count||0).toLocaleString() + ' 讚好 / '",
        "    + Math.floor((i.duration_seconds||0)/60) + ' 分鐘\\n'",
        "    + '標籤：' + tags + '\\n'",
        "    + '連結：https://www.youtube.com/watch?v=' + (i.video_id||'');",
        "}",
        "",
        "function fmtNews(i) {",
        "  const kw = (i.keywords_zh || []).join('、');",
        "  const tags = (i.tags || []).join('、');",
        "  return '【新聞｜' + (i.source_name||'') + '】\\n'",
        "    + '標題：' + (i.headline||'') + '\\n'",
        "    + '撮要：' + (i.summary_zh||'') + '\\n'",
        "    + '關鍵詞：' + kw + '\\n'",
        "    + '語言：' + (i.language||'') + ' ／ 標籤：' + tags + '\\n'",
        "    + '連結：' + (i.url||'');",
        "}",
        "",
        "function fmtPod(i) {",
        "  const kw = (i.keywords_zh || []).join('、');",
        "  const tags = (i.podcast_tags || []).join('、');",
        "  return '【Podcast｜' + (i.podcast_name||'') + '】\\n'",
        "    + '標題：' + (i.title||'') + '\\n'",
        "    + '撮要：' + (i.summary_zh||'') + '\\n'",
        "    + '關鍵詞：' + kw + '\\n'",
        "    + '數據：' + Math.floor((i.duration_seconds||0)/60) + ' 分鐘\\n'",
        "    + '標籤：' + tags + '\\n'",
        "    + '連結：' + (i.episode_url||'');",
        "}",
        "",
        "const ytBlock = yt.length > 0 ? yt.map(fmtYt).join('\\n\\n') : '（今日無YouTube資料）';",
        "const newsBlock = news.length > 0 ? news.map(fmtNews).join('\\n\\n') : '（今日無新聞資料）';",
        "const podBlock = pods.length > 0 ? pods.map(fmtPod).join('\\n\\n') : '（今日無Podcast資料）';",
        "const topVideo = yt.length > 0",
        "  ? (yt[0].title||'N/A').substring(0,50) + '（' + (yt[0].view_count||0).toLocaleString() + ' 觀看）'",
        "  : 'N/A';",
        "",
        "let prompt;",
        "if (total === 0) {",
        "  prompt = '你是利世民的個人情報助理。今日（' + dateStr + '）暫時無收集到任何資料。'",
        "    + '請用繁體中文撰寫一份簡短的' + slotLabel + '，說明今日暫無新資料，並提醒明日繼續關注。使用Markdown格式。';",
        "} else {",
        "  const podSec = pods.length > 0",
        "    ? '## 🎙 Podcast（最優先）\\n以下是來自Podcast的最新內容，請務必在簡報中獨立呈現：\\n\\n' + podBlock + '\\n\\n---'",
        "    : '';",
        "  prompt = '你是利世民的個人情報助理。請根據以下今日收集的資料，用繁體中文撰寫一份' + slotLabel + '簡報。\\n\\n'",
        "    + '日期：' + dateStr + '（香港時間）\\n'",
        "    + '資料來源數量：共 ' + total + ' 項（YouTube ' + yt.length + ' 項，新聞 ' + news.length + ' 項，Podcast ' + pods.length + ' 項）\\n\\n'",
        "    + '---\\n\\n請按以下格式撰寫，使用Markdown：\\n\\n'",
        "    + '# ' + dateStr + ' ' + slotLabel + '\\n\\n'",
        "    + podSec + '\\n\\n'",
        "    + '## 頭條故事\\n列出今日最重要的 10 個故事。每條頭條包括：\\n- 一句話標題\\n- 2至3句分析\\n- 來源及連結\\n\\n'",
        "    + '## 主題分析\\n將所有項目歸納為 7 個主題。每個主題下：\\n- 主題標題\\n- 2至3句概括該主題今日動態\\n- 列出相關項目標題及來源\\n\\n'",
        "    + '## 數字速覽\\n- 今日監測項目總數：' + total + '\\n- YouTube頻道：' + yt.length + ' 條影片\\n- 新聞來源：' + news.length + ' 篇文章\\n- Podcast：' + pods.length + ' 集\\n- 最高觀看影片：' + topVideo + '\\n\\n'",
        "    + '## 編輯備注\\n用2至3句話點出今日整體資訊環境的特點。\\n\\n'",
        "    + '---\\n\\n以下是今日所有資料：\\n\\n'",
        "    + '### 🎙 Podcast（最優先，獨立成節）\\n' + podBlock + '\\n\\n'",
        "    + '### YouTube影片\\n' + ytBlock + '\\n\\n'",
        "    + '### 新聞文章\\n' + newsBlock + '\\n\\n'",
        "    + '---\\n請直接輸出Markdown內容，不要加任何前言或說明。';",
        "}",
        "",
        "return [{ json: { prompt, dateStr, slot, slotLabel, total } }];"
      ].join('\n'),
    },
    position: [720, 300]
  },
  output: [{ prompt: 'test', dateStr: '2026-04-14', slot: 'evening', slotLabel: '晚報', total: 0 }]
});

const callSonnet = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Generate Briefing',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'list', value: 'claude-sonnet-4-5' },
      messages: { values: [{ content: expr('{{ $json.prompt }}'), role: 'user' }] },
      simplify: true,
      options: { maxTokens: 8192, temperature: 0.7 }
    },
    credentials: { anthropicApi: newCredential('Anthropic') },
    position: [960, 300]
  },
  output: [{ text: '# 2026-04-14 晚報' }]
});

const formatHtml = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Format Email HTML',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        "const prev = $input.first().json;",
        "const briefingMd = prev.text || prev.output || prev.mergedResponse || JSON.stringify(prev);",
        "const meta = $('Build Briefing Prompt').first().json;",
        "const dateStr = meta.dateStr;",
        "const slot = meta.slot;",
        "const slotLabel = meta.slotLabel;",
        "const subject = '【情報簡報】' + dateStr + ' ' + slotLabel;",
        "",
        "function mdToHtml(md) {",
        "  let h = md;",
        "  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');",
        "  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');",
        "  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');",
        "  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');",
        "  h = h.replace(/\\*(.+?)\\*/g, '<em>$1</em>');",
        "  h = h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href=\"$2\">$1</a>');",
        "  h = h.replace(/^---$/gm, '<hr>');",
        "  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');",
        "  const lines = h.split('\\n');",
        "  let out = [];",
        "  let inList = false;",
        "  for (const line of lines) {",
        "    if (line.startsWith('<li>')) {",
        "      if (!inList) { out.push('<ul>'); inList = true; }",
        "      out.push(line);",
        "    } else {",
        "      if (inList) { out.push('</ul>'); inList = false; }",
        "      if (line.trim() && !line.startsWith('<h') && !line.startsWith('<hr')",
        "          && !line.startsWith('<ul') && !line.startsWith('<li')) {",
        "        out.push('<p>' + line + '</p>');",
        "      } else {",
        "        out.push(line);",
        "      }",
        "    }",
        "  }",
        "  if (inList) out.push('</ul>');",
        "  return out.join('\\n');",
        "}",
        "",
        "const bodyHtml = mdToHtml(briefingMd);",
        "const css = 'body{font-family:-apple-system,PingFang HK,Microsoft JhengHei,sans-serif;'",
        "  + 'font-size:15px;line-height:1.7;color:#1a1a1a;max-width:680px;margin:0 auto;padding:24px 16px}'",
        "  + 'h1{font-size:22px;border-bottom:2px solid #1a1a1a;padding-bottom:8px}'",
        "  + 'h2{font-size:17px;margin-top:28px;border-left:3px solid #d4a017;padding-left:10px}'",
        "  + 'h3{font-size:15px;margin-top:16px;color:#333}'",
        "  + 'p{margin:8px 0}ul{padding-left:20px}li{margin:4px 0}'",
        "  + 'a{color:#0066cc;text-decoration:none}'",
        "  + 'hr{border:none;border-top:1px solid #e0e0e0;margin:24px 0}';",
        "",
        "const html = '<!DOCTYPE html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\">'",
        "  + '<title>' + subject + '</title><style>' + css + '</style></head><body>'",
        "  + bodyHtml",
        "  + '<div style=\"margin-top:32px;font-size:12px;color:#999;border-top:1px solid #e0e0e0;padding-top:12px\">'",
        "  + '由 Socialisn Intelligence Monitor 自動生成</div></body></html>';",
        "",
        "return [{ json: { dateStr, slot, slotLabel, markdown: briefingMd, html, subject } }];"
      ].join('\n'),
    },
    position: [1200, 300]
  },
  output: [{ dateStr: '2026-04-14', slot: 'evening', slotLabel: '晚報', markdown: '# test', html: '<p>test</p>', subject: '【情報簡報】2026-04-14 晚報' }]
});

const saveBriefing = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Briefing',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO briefings (date, slot, markdown, html, generated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (date, slot) DO UPDATE SET markdown = EXCLUDED.markdown, html = EXCLUDED.html, generated_at = NOW()",
      options: {
        queryReplacement: expr('{{ [$json.dateStr, $json.slot, $json.markdown, $json.html] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [1440, 300]
  },
  output: [{}]
});

const sendEmail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: 'Send Briefing Email',
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: placeholder('Recipient email (e.g. name@example.com)'),
      subject: expr('{{ $("Format Email HTML").item.json.subject }}'),
      emailType: 'html',
      message: expr('{{ $("Format Email HTML").item.json.html }}'),
      options: { appendAttribution: false, senderName: 'Socialisn Intelligence' }
    },
    credentials: { gmailOAuth2: newCredential('Gmail') },
    position: [1680, 300]
  },
  output: [{ id: 'msg123' }]
});

export default workflow('generate-briefing', 'Generate Daily Briefing')
  .add(schedule)
  .to(fetchItems)
  .to(buildPrompt)
  .to(callSonnet)
  .to(formatHtml)
  .to(saveBriefing)
  .to(sendEmail);
