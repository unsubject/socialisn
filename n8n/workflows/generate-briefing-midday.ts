import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const buildPromptCode = `const row = $input.first().json;
const yt   = Array.isArray(row.youtube_items)    ? row.youtube_items    : [];
const news = Array.isArray(row.news_items)       ? row.news_items       : [];
const pods = Array.isArray(row.podcast_items)    ? row.podcast_items    : [];
const nls  = Array.isArray(row.newsletter_items) ? row.newsletter_items : [];
const fbs  = Array.isArray(row.frontier_briefings) ? row.frontier_briefings : [];

const dateStr = row.briefing_date;
const total = yt.length + news.length + pods.length + nls.length;

// No delta and no new frontier — exit without calling the LLM.
if (total === 0 && fbs.length === 0) {
  return [];
}

function fmtYt(i) {
  const kw   = (i.keywords_zh  || []).join('、');
  return '【YouTube｜' + (i.channel_name||'') + '】\n'
    + '標題：' + (i.title||'') + '\n'
    + '撮要：' + (i.summary_zh||'') + '\n'
    + '關鍵詞：' + kw + '\n'
    + '連結：https://www.youtube.com/watch?v=' + (i.video_id||'');
}
function fmtNews(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【新聞｜' + (i.source_name||'') + '】\n'
    + '標題：' + (i.headline||'') + '\n'
    + '撮要：' + (i.summary_zh||'') + '\n'
    + '關鍵詞：' + kw + '\n'
    + '連結：' + (i.url||'');
}
function fmtPod(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【Podcast｜' + (i.podcast_name||'') + '】\n'
    + '標題：' + (i.title||'') + '\n'
    + '撮要：' + (i.summary_zh||'') + '\n'
    + '關鍵詞：' + kw + '\n'
    + '連結：' + (i.episode_url||'');
}
function fmtNl(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【Newsletter｜' + (i.sender_name || i.sender_email || '') + '】\n'
    + '主題：' + (i.subject||'') + '\n'
    + '撮要：' + (i.summary_zh || i.summary || '') + '\n'
    + '關鍵詞：' + kw;
}

const prompt = '你是利世民的個人情報助理。以下是自今晨早報以來新增的資料。'
  + '請用繁體中文撰寫一份精簡的午報更新，聚焦於新增內容的重點。\n\n'
  + '日期：' + dateStr + '（美東時間）\n'
  + '新增項目：共 ' + total + ' 項（YouTube ' + yt.length + ' ／ 新聞 ' + news.length
  + ' ／ Podcast ' + pods.length + ' ／ Newsletter ' + nls.length + '）\n'
  + (fbs.length > 0 ? '另附新增的 FrontierWatch 前沿板塊 ' + fbs.length + ' 個（將於結尾原文附上，你毫須處理）\n' : '')
  + '\n---\n\n請按以下格式撰寫，使用Markdown：\n\n'
  + '# ' + dateStr + ' 午報（更新）\n\n'
  + '## 新增重點\n列出自早報以來最重要的3至7個新增故事。每條包括：\n- 標題\n- 1至2句分析\n- 來源及連結\n\n'
  + '## 變化追蹤\n用 2至3 句話點出自早報以來資訊環境的主要變化。\n\n'
  + '---\n\n以下是新增資料：\n\n'
  + '### Newsletter\n' + (nls.length ? nls.map(fmtNl).join('\n\n') : '（無）') + '\n\n'
  + '### YouTube影片\n' + (yt.length ? yt.map(fmtYt).join('\n\n') : '（無）') + '\n\n'
  + '### 新聞文章\n' + (news.length ? news.map(fmtNews).join('\n\n') : '（無）') + '\n\n'
  + '### Podcast\n' + (pods.length ? pods.map(fmtPod).join('\n\n') : '（無）') + '\n\n'
  + '---\n請直接輸出Markdown內容，不要加任何前言或說明。不要包含 FrontierWatch 段落，我會在之後另行附上。';

return [{ json: { prompt, dateStr, total, frontier: fbs } }];`;

const combineCode = `const sonnet = $json;
const meta = $('Build Midday Prompt').first().json;
let briefingMd = '';
if (sonnet && Array.isArray(sonnet.content) && sonnet.content.length > 0) {
  briefingMd = String(sonnet.content[0].text || '').trim();
}
if (!briefingMd) briefingMd = '# ' + meta.dateStr + ' 午報（更新）\n\n（簡報生成失敗，請查 n8n 執行記錄）';

const fbs = Array.isArray(meta.frontier) ? meta.frontier : [];
if (fbs.length > 0) {
  const parts = ['', '---', '', '## 前沿追蹤（FrontierWatch）', ''];
  for (const f of fbs) {
    const title = f.title || f.slug || '';
    const theme = f.theme ? '（' + f.theme + '）' : '';
    parts.push('### ' + title + theme);
    parts.push('_' + (f.slug || '') + ' · ' + (f.date_range || f.date_published || '') + '_');
    parts.push('');
    parts.push(String(f.content_md || '').trim());
    parts.push('');
  }
  briefingMd = briefingMd + parts.join('\n');
}

const usage = (sonnet && sonnet.usage) || {};
return [{ json: {
  dateStr: meta.dateStr,
  markdown: briefingMd,
  prompt_tokens: usage.input_tokens || null,
  output_tokens: usage.output_tokens || null,
} }];`;

const deltaSourcesSQL = `SELECT
  $1::text AS briefing_date,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT y.video_id, y.channel_name, y.channel_tags, y.title,
           y.view_count, y.like_count, y.duration_seconds,
           e.summary_zh, e.keywords_zh
      FROM youtube_items y
      LEFT JOIN item_enrichment e ON e.item_type = 'youtube' AND e.item_id = y.video_id
     WHERE y.fetched_at > $2::timestamptz
     ORDER BY y.view_count DESC
  ) sub), '[]'::json) AS youtube_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT n.article_id, n.source_name, n.headline, n.url, n.language, n.tags,
           e.summary_zh, e.keywords_zh
      FROM news_items n
      LEFT JOIN item_enrichment e ON e.item_type = 'news' AND e.item_id = n.article_id
     WHERE n.fetched_at > $2::timestamptz
     ORDER BY n.published_at DESC NULLS LAST
  ) sub), '[]'::json) AS news_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT p.episode_id, p.podcast_name, p.podcast_tags, p.title,
           p.episode_url, p.duration_seconds,
           e.summary_zh, e.keywords_zh
      FROM podcast_items p
      LEFT JOIN item_enrichment e ON e.item_type = 'podcast' AND e.item_id = p.episode_id
     WHERE p.fetched_at > $2::timestamptz
     ORDER BY p.published_at DESC NULLS LAST
  ) sub), '[]'::json) AS podcast_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT nl.message_id, nl.sender_email, nl.sender_name, nl.subject,
           nl.summary, e.summary_zh, e.keywords_zh
      FROM newsletter_items nl
      LEFT JOIN item_enrichment e ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
     WHERE nl.fetched_at > $2::timestamptz
     ORDER BY nl.received_at DESC NULLS LAST
  ) sub), '[]'::json) AS newsletter_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT DISTINCT ON (fb.slug)
           fb.slug, fb.title, fb.theme, fb.content_md,
           fb.date_range, fb.date_published, fb.generated_at
      FROM frontier_briefings fb
     WHERE fb.generated_at > $2::timestamptz
     ORDER BY fb.slug, fb.generated_at DESC
  ) sub), '[]'::json) AS frontier_briefings`;

const scheduledCutoffSQL = `SELECT
  (NOW() AT TIME ZONE 'America/New_York')::date::text AS briefing_date,
  COALESCE(
    (SELECT generated_at FROM briefings
       WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = 'morning'),
    NOW() - INTERVAL '24 hours'
  )::text AS cutoff_ts
WHERE NOT EXISTS (
  SELECT 1 FROM briefings
   WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = 'midday'
)`;

const telegramCutoffSQL = `SELECT
  (NOW() AT TIME ZONE 'America/New_York')::date::text AS briefing_date,
  COALESCE(
    (SELECT generated_at FROM briefings
       WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = 'morning'),
    NOW() - INTERVAL '24 hours'
  )::text AS cutoff_ts`;

const middayCron = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 14:00 ET',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 14 * * *' }] },
      timezone: 'America/New_York'
    },
    position: [240, 200]
  },
  output: [{}]
});

const telegramEntry = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'From Telegram /midday',
    parameters: {},
    position: [240, 500]
  },
  output: [{ chat_id: null }]
});

const scheduledCutoff = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Scheduled Cutoff (skip if exists)',
    parameters: { operation: 'executeQuery', query: scheduledCutoffSQL },
    credentials: { postgres: newCredential('Railway') },
    position: [480, 200]
  },
  output: [{ briefing_date: '', cutoff_ts: '' }]
});

const telegramCutoff = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Telegram Cutoff',
    parameters: { operation: 'executeQuery', query: telegramCutoffSQL },
    credentials: { postgres: newCredential('Railway') },
    position: [480, 500]
  },
  output: [{ briefing_date: '', cutoff_ts: '' }]
});

const fetchDelta = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Delta',
    parameters: {
      operation: 'executeQuery',
      query: deltaSourcesSQL,
      options: {
        queryReplacement: '={{ [$json.briefing_date, $json.cutoff_ts] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [720, 350]
  },
  output: [{ briefing_date: '', youtube_items: [], news_items: [], podcast_items: [], newsletter_items: [], frontier_briefings: [] }]
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Midday Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: buildPromptCode
    },
    position: [960, 350]
  },
  output: [{ prompt: '', dateStr: '', total: 0, frontier: [] }]
});

const callSonnet = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call Sonnet',
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'anthropic-version', value: '2023-06-01' }]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 4096, temperature: 0.7, messages: [{ role: "user", content: $json.prompt }] }) }}',
      options: {
        response: { response: { responseFormat: 'json' } },
        timeout: 120000
      }
    },
    credentials: { httpHeaderAuth: newCredential('Anthropic API Key') },
    position: [1200, 350]
  },
  output: [{ content: [{ text: '' }], usage: { input_tokens: 0, output_tokens: 0 } }]
});

const combineBriefing = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Combine Briefing',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: combineCode
    },
    position: [1440, 350]
  },
  output: [{ dateStr: '', markdown: '', prompt_tokens: 0, output_tokens: 0 }]
});

const saveBriefing = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Midday Briefing',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO briefings (date, slot, markdown, prompt_tokens, output_tokens, generated_at) VALUES ($1::date, 'midday', $2, $3, $4, NOW()) ON CONFLICT (date, slot) DO UPDATE SET markdown = EXCLUDED.markdown, prompt_tokens = EXCLUDED.prompt_tokens, output_tokens = EXCLUDED.output_tokens, generated_at = NOW()",
      options: {
        queryReplacement: '={{ [$json.dateStr, $json.markdown, $json.prompt_tokens, $json.output_tokens] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [1680, 350]
  },
  output: [{}]
});

export default workflow('generate-briefing-midday', 'Generate Briefing · Midday')
  .add(middayCron)
  .to(scheduledCutoff)
  .to(fetchDelta)
  .to(buildPrompt)
  .to(callSonnet)
  .to(combineBriefing)
  .to(saveBriefing)
  .add(telegramEntry)
  .to(telegramCutoff)
  .to(fetchDelta);
