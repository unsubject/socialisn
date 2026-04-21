import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const buildPromptCode = `const row = $input.first().json;
const yt   = Array.isArray(row.youtube_items)    ? row.youtube_items    : [];
const news = Array.isArray(row.news_items)       ? row.news_items       : [];
const pods = Array.isArray(row.podcast_items)    ? row.podcast_items    : [];
const nls  = Array.isArray(row.newsletter_items) ? row.newsletter_items : [];
const fbs  = Array.isArray(row.frontier_briefings) ? row.frontier_briefings : [];
const sig  = Array.isArray(row.gdelt_signal)       ? row.gdelt_signal       : [];

const dateStr = row.briefing_date;
const total = yt.length + news.length + pods.length + nls.length;

function fmtYt(i) {
  const kw   = (i.keywords_zh  || []).join('、');
  const tags = (i.channel_tags || []).join('、');
  return '【YouTube｜' + (i.channel_name||'') + '】\\n'
    + '標題：' + (i.title||'') + '\\n'
    + '撮要：' + (i.summary_zh||'') + '\\n'
    + '關鍵詞：' + kw + '\\n'
    + '數據：' + (i.view_count||0).toLocaleString() + ' 觀看 / '
    + (i.like_count||0).toLocaleString() + ' 讚好 / '
    + Math.floor((i.duration_seconds||0)/60) + ' 分鐘\\n'
    + '標籤：' + tags + '\\n'
    + '連結：https://www.youtube.com/watch?v=' + (i.video_id||'');
}

function fmtNews(i) {
  const kw   = (i.keywords_zh || []).join('、');
  const tags = (i.tags || []).join('、');
  return '【新聞｜' + (i.source_name||'') + '】\\n'
    + '標題：' + (i.headline||'') + '\\n'
    + '撮要：' + (i.summary_zh||'') + '\\n'
    + '關鍵詞：' + kw + '\\n'
    + '語言：' + (i.language||'') + ' ／ 標籤：' + tags + '\\n'
    + '連結：' + (i.url||'');
}

function fmtPod(i) {
  const kw   = (i.keywords_zh || []).join('、');
  const tags = (i.podcast_tags || []).join('、');
  return '【Podcast｜' + (i.podcast_name||'') + '】\\n'
    + '標題：' + (i.title||'') + '\\n'
    + '撮要：' + (i.summary_zh||'') + '\\n'
    + '關鍵詞：' + kw + '\\n'
    + '數據：' + Math.floor((i.duration_seconds||0)/60) + ' 分鐘\\n'
    + '標籤：' + tags + '\\n'
    + '連結：' + (i.episode_url||'');
}

function fmtNl(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【Newsletter｜' + (i.sender_name || i.sender_email || '') + '】\\n'
    + '主題：' + (i.subject||'') + '\\n'
    + '撮要：' + (i.summary_zh || i.summary || '') + '\\n'
    + '關鍵詞：' + kw;
}

function fmtSignalRow(s) {
  const tone = (s.tone !== null && s.tone !== undefined) ? Number(s.tone).toFixed(2) : '—';
  const tone7d = (s.tone_7d_avg !== null && s.tone_7d_avg !== undefined) ? Number(s.tone_7d_avg).toFixed(2) : '—';
  const articles = (s.articles !== null && s.articles !== undefined) ? s.articles : '—';
  const avg7 = Number(s.articles_7d_avg) || 0;
  const ratio = (avg7 > 0) ? (s.articles / avg7).toFixed(2) + 'x' : '—';
  const countries = Array.isArray(s.top_source_countries)
    ? s.top_source_countries.slice(0,3).map(function(c){ return c.name || ''; }).filter(Boolean).join(', ')
    : '—';
  return '| ' + s.lane + ' | ' + articles + ' (' + ratio + ') | ' + tone + ' | ' + tone7d + ' | ' + (countries || '—') + ' |';
}

let signalBlock = '';
if (sig.length > 0) {
  signalBlock = '## 全球訊號（GDELT，過去24小時；7日平均為基準）\\n\\n'
    + '| 軌道 | 今日文章（量比） | 今日語氣 | 7日平均語氣 | 主要來源國 |\\n'
    + '|---|---:|---:|---:|---|\\n'
    + sig.map(fmtSignalRow).join('\\n') + '\\n\\n'
    + '（語氣範圍 -10 至 +10。量比 >1 代表文章量高於7日均值；語氣低於7日均值代表負面情緒升溫。僅供參考，由你決定是否在簡報中引用。）';
}

const ytBlock   = yt.length   > 0 ? yt.map(fmtYt).join('\\n\\n')     : '（過去24小時無YouTube資料）';
const newsBlock = news.length > 0 ? news.map(fmtNews).join('\\n\\n') : '（過去24小時無新聞資料）';
const podBlock  = pods.length > 0 ? pods.map(fmtPod).join('\\n\\n')  : '（過去24小時無Podcast資料）';
const nlBlock   = nls.length  > 0 ? nls.map(fmtNl).join('\\n\\n')    : '（過去24小時無Newsletter資料）';

const topVideo = yt.length > 0
  ? (yt[0].title||'N/A').substring(0,50) + '（' + (yt[0].view_count||0).toLocaleString() + ' 觀看）'
  : 'N/A';

let prompt;
if (total === 0 && fbs.length === 0 && sig.length === 0) {
  prompt = '你是利世民的個人情報助理。今日（' + dateStr + '，美東時間）暫時無收集到任何資料。'
    + '請用繁體中文撰寫一份簡短的早報，說明今日暫無新資料，並提醒稍後繼續關注。使用Markdown格式。'
    + '標題使用「# ' + dateStr + ' 早報」。';
} else {
  prompt = '你是利世民的個人情報助理。請根據以下過去24小時收集的資料，用繁體中文撰寫一份早報簡報。\\n\\n'
    + '日期：' + dateStr + '（美東時間）\\n'
    + '資料來源數量：共 ' + total + ' 項（YouTube ' + yt.length + ' ／ 新聞 ' + news.length
    + ' ／ Podcast ' + pods.length + ' ／ Newsletter ' + nls.length + '）\\n'
    + '另附 FrontierWatch 前沿板塊 ' + fbs.length + ' 個（將於簡報結尾原文附上，你毋須處理）\\n\\n'
    + (signalBlock ? '---\\n\\n' + signalBlock + '\\n\\n' : '')
    + '---\\n\\n請按以下格式撰寫，使用Markdown：\\n\\n'
    + '# ' + dateStr + ' 早報\\n\\n'
    + '## 頭條故事\\n列出今日最重要的 10 個故事。每條頭條包括：\\n- 一句話標題\\n- 2至3句分析\\n- 來源及連結\\n\\n'
    + '## 主題分析\\n將所有項目歸納為 5 至 7 個主題。每個主題下：\\n- 主題標題\\n- 2至3句概括該主題今日動態\\n- 列出相關項目標題及來源\\n\\n'
    + '## 數字速覽\\n- 今日監測項目總數：' + total + '\\n- YouTube頻道：' + yt.length + ' 條影片\\n'
    + '- 新聞來源：' + news.length + ' 篇文章\\n- Podcast：' + pods.length + ' 集\\n'
    + '- Newsletter：' + nls.length + ' 篇\\n- 最高觀看影片：' + topVideo + '\\n\\n'
    + '## 編輯備注\\n用2至3句話點出今日整體資訊環境的特點。\\n\\n'
    + '---\\n\\n以下是過去24小時所有資料：\\n\\n'
    + '### Newsletter\\n' + nlBlock + '\\n\\n'
    + '### YouTube影片\\n' + ytBlock + '\\n\\n'
    + '### 新聞文章\\n' + newsBlock + '\\n\\n'
    + '### Podcast\\n' + podBlock + '\\n\\n'
    + '---\\n請直接輸出Markdown內容，不要加任何前言或說明。不要包含 FrontierWatch 段落，我會在之後另行附上。';
}

return [{ json: { prompt, dateStr, total, frontier: fbs } }];`;

const combineCode = `const sonnet = $json;
const meta = $('Build Morning Prompt').first().json;
let briefingMd = '';
if (sonnet && Array.isArray(sonnet.content) && sonnet.content.length > 0) {
  briefingMd = String(sonnet.content[0].text || '').trim();
}
if (!briefingMd) briefingMd = '# ' + meta.dateStr + ' 早報\\n\\n（簡報生成失敗，請查 n8n 執行記錄）';

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
  briefingMd = briefingMd + parts.join('\\n');
}

const usage = (sonnet && sonnet.usage) || {};
return [{ json: {
  dateStr: meta.dateStr,
  markdown: briefingMd,
  prompt_tokens: usage.input_tokens || null,
  output_tokens: usage.output_tokens || null,
} }];`;

const fetchSourcesSQL = `SELECT
  (NOW() AT TIME ZONE 'America/New_York')::date::text AS briefing_date,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT y.video_id, y.channel_name, y.channel_tags, y.title,
           y.view_count, y.like_count, y.duration_seconds,
           e.summary_zh, e.keywords_zh
      FROM youtube_items y
      LEFT JOIN item_enrichment e ON e.item_type = 'youtube' AND e.item_id = y.video_id
     WHERE y.fetched_at >= NOW() - INTERVAL '24 hours'
     ORDER BY y.view_count DESC
  ) sub), '[]'::json) AS youtube_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT n.article_id, n.source_name, n.headline, n.url, n.language, n.tags,
           e.summary_zh, e.keywords_zh
      FROM news_items n
      LEFT JOIN item_enrichment e ON e.item_type = 'news' AND e.item_id = n.article_id
     WHERE n.fetched_at >= NOW() - INTERVAL '24 hours'
     ORDER BY n.published_at DESC NULLS LAST
  ) sub), '[]'::json) AS news_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT p.episode_id, p.podcast_name, p.podcast_tags, p.title,
           p.episode_url, p.duration_seconds,
           e.summary_zh, e.keywords_zh
      FROM podcast_items p
      LEFT JOIN item_enrichment e ON e.item_type = 'podcast' AND e.item_id = p.episode_id
     WHERE p.fetched_at >= NOW() - INTERVAL '24 hours'
     ORDER BY p.published_at DESC NULLS LAST
  ) sub), '[]'::json) AS podcast_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT nl.message_id, nl.sender_email, nl.sender_name, nl.subject,
           nl.summary, e.summary_zh, e.keywords_zh
      FROM newsletter_items nl
      LEFT JOIN item_enrichment e ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
     WHERE nl.fetched_at >= NOW() - INTERVAL '24 hours'
     ORDER BY nl.received_at DESC NULLS LAST
  ) sub), '[]'::json) AS newsletter_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT DISTINCT ON (fb.slug)
           fb.slug, fb.title, fb.theme, fb.content_md,
           fb.date_range, fb.date_published, fb.generated_at
      FROM frontier_briefings fb
     WHERE fb.generated_at >= NOW() - INTERVAL '24 hours'
     ORDER BY fb.slug, fb.generated_at DESC
  ) sub), '[]'::json) AS frontier_briefings,
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'lane', t.lane,
        'articles', t.articles,
        'tone', t.avg_tone,
        'articles_7d_avg', (
          SELECT ROUND(AVG(g.articles)::numeric, 0)::int
            FROM gdelt_signal g
           WHERE g.lane = t.lane
             AND g.day < t.day
             AND g.day >= t.day - INTERVAL '7 days'
        ),
        'tone_7d_avg', (
          SELECT ROUND(AVG(g.avg_tone)::numeric, 2)
            FROM gdelt_signal g
           WHERE g.lane = t.lane
             AND g.day < t.day
             AND g.day >= t.day - INTERVAL '7 days'
        ),
        'top_source_countries', t.top_source_countries,
        'top_langs', t.top_langs
      ) ORDER BY t.lane
    )
    FROM gdelt_signal t
    WHERE t.day = (NOW() AT TIME ZONE 'America/New_York')::date
  ), '[]'::json) AS gdelt_signal`;

const morningCron = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 08:00 ET',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] },
      timezone: 'America/New_York'
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchSources = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Sources (24h)',
    parameters: {
      operation: 'executeQuery',
      query: fetchSourcesSQL
    },
    credentials: { postgres: newCredential('Railway') },
    position: [480, 300]
  },
  output: [{ briefing_date: '2026-04-19', youtube_items: [], news_items: [], podcast_items: [], newsletter_items: [], frontier_briefings: [], gdelt_signal: [] }]
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Morning Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: buildPromptCode
    },
    position: [720, 300]
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
      jsonBody: '={{ JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 8192, temperature: 0.7, messages: [{ role: "user", content: $json.prompt }] }) }}',
      options: {
        response: { response: { responseFormat: 'json' } },
        timeout: 120000
      }
    },
    credentials: { httpHeaderAuth: newCredential('Anthropic API Key') },
    position: [960, 300]
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
    position: [1200, 300]
  },
  output: [{ dateStr: '', markdown: '', prompt_tokens: 0, output_tokens: 0 }]
});

const saveBriefing = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Morning Briefing',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO briefings (date, slot, markdown, prompt_tokens, output_tokens, generated_at) VALUES ($1::date, 'morning', $2, $3, $4, NOW()) ON CONFLICT (date, slot) DO UPDATE SET markdown = EXCLUDED.markdown, prompt_tokens = EXCLUDED.prompt_tokens, output_tokens = EXCLUDED.output_tokens, generated_at = NOW()",
      options: {
        queryReplacement: '={{ [$json.dateStr, $json.markdown, $json.prompt_tokens, $json.output_tokens] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [1440, 300]
  },
  output: [{}]
});

export default workflow('generate-briefing-morning', 'Generate Briefing · Morning')
  .add(morningCron)
  .to(fetchSources)
  .to(buildPrompt)
  .to(callSonnet)
  .to(combineBriefing)
  .to(saveBriefing);
