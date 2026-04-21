import { workflow, trigger, node, ifElse, newCredential } from '@n8n/workflow-sdk';

const setMiddayCode = `return [{ json: { slot: 'midday', source: 'scheduled', chat_id: null } }];`;

const setEveningCode = `return [{ json: { slot: 'evening', source: 'scheduled', chat_id: null } }];`;

const computeTelegramSlotCode = `const msg = $json.message || {};
const chat_id = (msg.chat && msg.chat.id) ? msg.chat.id : null;
const etHourStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
const etHour = parseInt(etHourStr, 10);
const slot = (isNaN(etHour) || etHour < 17) ? 'midday' : 'evening';
return [{ json: { slot, source: 'telegram', chat_id } }];`;

const buildPromptCode = `const row = $input.first().json;
const slot = row.slot;
const slotLabel = slot === 'midday' ? '午報' : '晚報';
const deltaRef = slot === 'midday' ? '今晨早報' : '今日上一次簡報（午報或早報）';

const yt   = Array.isArray(row.youtube_items)    ? row.youtube_items    : [];
const news = Array.isArray(row.news_items)       ? row.news_items       : [];
const pods = Array.isArray(row.podcast_items)    ? row.podcast_items    : [];
const nls  = Array.isArray(row.newsletter_items) ? row.newsletter_items : [];
const fbs  = Array.isArray(row.frontier_briefings) ? row.frontier_briefings : [];
const sig  = Array.isArray(row.gdelt_signal)       ? row.gdelt_signal       : [];

const dateStr = row.briefing_date;
const total = yt.length + news.length + pods.length + nls.length;

if (total === 0 && fbs.length === 0) {
  return [{ json: {
    skip: true,
    slot, slotLabel, dateStr,
    source: row.source, chat_id: row.chat_id,
    frontier: fbs
  } }];
}

function fmtYt(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【YouTube｜' + (i.channel_name||'') + '】\\n'
    + '標題：' + (i.title||'') + '\\n'
    + '撮要：' + (i.summary_zh||'') + '\\n'
    + '關鍵詞：' + kw + '\\n'
    + '連結：https://www.youtube.com/watch?v=' + (i.video_id||'');
}
function fmtNews(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【新聞｜' + (i.source_name||'') + '】\\n'
    + '標題：' + (i.headline||'') + '\\n'
    + '撮要：' + (i.summary_zh||'') + '\\n'
    + '關鍵詞：' + kw + '\\n'
    + '連結：' + (i.url||'');
}
function fmtPod(i) {
  const kw = (i.keywords_zh || []).join('、');
  return '【Podcast｜' + (i.podcast_name||'') + '】\\n'
    + '標題：' + (i.title||'') + '\\n'
    + '撮要：' + (i.summary_zh||'') + '\\n'
    + '關鍵詞：' + kw + '\\n'
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
  signalBlock = '## 全球訊號（GDELT，今日快照；7日平均為基準）\\n\\n'
    + '| 軌道 | 今日文章（量比） | 今日語氣 | 7日平均語氣 | 主要來源國 |\\n'
    + '|---|---:|---:|---:|---|\\n'
    + sig.map(fmtSignalRow).join('\\n') + '\\n\\n'
    + '（語氣範圍 -10 至 +10。量比 >1 代表文章量高於7日均值；語氣低於7日均值代表負面情緒升溫。僅供參考，由你決定是否在簡報中引用。）';
}

const summarySection = slot === 'midday'
  ? '## 變化追蹤\\n用 2至3 句話點出自早報以來資訊環境的主要變化。'
  : '## 今日總結\\n用 3至4 句話總結今日整體的資訊環境變化、主要主題、以及值得關注的越境信號。';

const prompt = '你是利世民的個人情報助理。以下是自' + deltaRef + '以來新增的資料。'
  + '請用繁體中文撰寫一份精簡的' + slotLabel + '更新，聚焦於新增內容的重點。\\n\\n'
  + '日期：' + dateStr + '（美東時間）\\n'
  + '新增項目：共 ' + total + ' 項（YouTube ' + yt.length + ' ／ 新聞 ' + news.length
  + ' ／ Podcast ' + pods.length + ' ／ Newsletter ' + nls.length + '）\\n'
  + (fbs.length > 0 ? '另附新增的 FrontierWatch 前沿板塊 ' + fbs.length + ' 個（將於結尾原文附上，你毋須處理）\\n' : '')
  + (signalBlock ? '\\n---\\n\\n' + signalBlock + '\\n\\n' : '\\n')
  + '---\\n\\n請按以下格式撰寫，使用Markdown：\\n\\n'
  + '# ' + dateStr + ' ' + slotLabel + '（更新）\\n\\n'
  + '## 新增重點\\n列出自' + deltaRef + '以來最重要的 3 至 7 個新增故事。每條包括：\\n- 標題\\n- 1至2句分析\\n- 來源及連結\\n\\n'
  + summarySection + '\\n\\n'
  + '---\\n\\n以下是新增資料：\\n\\n'
  + '### Newsletter\\n' + (nls.length ? nls.map(fmtNl).join('\\n\\n') : '（無）') + '\\n\\n'
  + '### YouTube影片\\n' + (yt.length ? yt.map(fmtYt).join('\\n\\n') : '（無）') + '\\n\\n'
  + '### 新聞文章\\n' + (news.length ? news.map(fmtNews).join('\\n\\n') : '（無）') + '\\n\\n'
  + '### Podcast\\n' + (pods.length ? pods.map(fmtPod).join('\\n\\n') : '（無）') + '\\n\\n'
  + '---\\n請直接輸出Markdown內容，不要加任何前言或說明。不要包含 FrontierWatch 段落，我會在之後另行附上。';

return [{ json: {
  skip: false,
  prompt, slot, slotLabel, dateStr, total,
  source: row.source, chat_id: row.chat_id,
  frontier: fbs
} }];`;

const combineCode = `const sonnet = $json;
const meta = $('Build Prompt').first().json;
let briefingMd = '';
if (sonnet && Array.isArray(sonnet.content) && sonnet.content.length > 0) {
  briefingMd = String(sonnet.content[0].text || '').trim();
}
if (!briefingMd) briefingMd = '# ' + meta.dateStr + ' ' + meta.slotLabel + '（更新）\\n\\n（簡報生成失敗，請查 n8n 執行記錄）';

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
  slot: meta.slot,
  slotLabel: meta.slotLabel,
  source: meta.source,
  chat_id: meta.chat_id,
  markdown: briefingMd,
  prompt_tokens: usage.input_tokens || null,
  output_tokens: usage.output_tokens || null,
} }];`;

const cutoffSQL = `SELECT
  (NOW() AT TIME ZONE 'America/New_York')::date::text AS briefing_date,
  $1::text AS slot,
  $2::text AS source,
  $3 AS chat_id,
  CASE $1::text
    WHEN 'midday' THEN
      COALESCE(
        (SELECT generated_at FROM briefings
           WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = 'morning'),
        NOW() - INTERVAL '24 hours'
      )::text
    WHEN 'evening' THEN
      COALESCE(
        (SELECT generated_at FROM briefings
           WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = 'midday'),
        (SELECT generated_at FROM briefings
           WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = 'morning'),
        NOW() - INTERVAL '24 hours'
      )::text
  END AS cutoff_ts
WHERE $2::text = 'telegram' OR NOT EXISTS (
  SELECT 1 FROM briefings
   WHERE date = (NOW() AT TIME ZONE 'America/New_York')::date AND slot = $1::text
)`;

const deltaSQL = `SELECT
  $1::text AS briefing_date,
  $2::text AS slot,
  $3::text AS source,
  $4 AS chat_id,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT y.video_id, y.channel_name, y.channel_tags, y.title,
           y.view_count, y.like_count, y.duration_seconds,
           e.summary_zh, e.keywords_zh
      FROM youtube_items y
      LEFT JOIN item_enrichment e ON e.item_type = 'youtube' AND e.item_id = y.video_id
     WHERE y.fetched_at > $5::timestamptz
     ORDER BY y.view_count DESC
  ) sub), '[]'::json) AS youtube_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT n.article_id, n.source_name, n.headline, n.url, n.language, n.tags,
           e.summary_zh, e.keywords_zh
      FROM news_items n
      LEFT JOIN item_enrichment e ON e.item_type = 'news' AND e.item_id = n.article_id
     WHERE n.fetched_at > $5::timestamptz
     ORDER BY n.published_at DESC NULLS LAST
  ) sub), '[]'::json) AS news_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT p.episode_id, p.podcast_name, p.podcast_tags, p.title,
           p.episode_url, p.duration_seconds,
           e.summary_zh, e.keywords_zh
      FROM podcast_items p
      LEFT JOIN item_enrichment e ON e.item_type = 'podcast' AND e.item_id = p.episode_id
     WHERE p.fetched_at > $5::timestamptz
     ORDER BY p.published_at DESC NULLS LAST
  ) sub), '[]'::json) AS podcast_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT nl.message_id, nl.sender_email, nl.sender_name, nl.subject,
           nl.summary, e.summary_zh, e.keywords_zh
      FROM newsletter_items nl
      LEFT JOIN item_enrichment e ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
     WHERE nl.fetched_at > $5::timestamptz
     ORDER BY nl.received_at DESC NULLS LAST
  ) sub), '[]'::json) AS newsletter_items,
  COALESCE((SELECT json_agg(sub) FROM (
    SELECT DISTINCT ON (fb.slug)
           fb.slug, fb.title, fb.theme, fb.content_md,
           fb.date_range, fb.date_published, fb.generated_at
      FROM frontier_briefings fb
     WHERE fb.generated_at > $5::timestamptz
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
    WHERE t.day = $1::date
  ), '[]'::json) AS gdelt_signal`;

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

const eveningCron = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 20:00 ET',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 20 * * *' }] },
      timezone: 'America/New_York'
    },
    position: [240, 400]
  },
  output: [{}]
});

const telegramTrigger_ = trigger({
  type: 'n8n-nodes-base.telegramTrigger',
  version: 1.2,
  config: {
    name: 'Telegram Trigger',
    parameters: {
      updates: ['message'],
      additionalFields: {}
    },
    position: [240, 600]
  },
  output: [{ message: { chat: { id: 0 }, text: 'Update' } }]
});

const setMidday = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Set Midday Context',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: setMiddayCode
    },
    position: [480, 200]
  },
  output: [{ slot: 'midday', source: 'scheduled', chat_id: null }]
});

const setEvening = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Set Evening Context',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: setEveningCode
    },
    position: [480, 400]
  },
  output: [{ slot: 'evening', source: 'scheduled', chat_id: null }]
});

const filterUpdate = ifElse({
  version: 2.2,
  config: {
    name: 'Is "Update"?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'cond-update',
            leftValue: '={{ $json.message.text }}',
            rightValue: 'Update',
            operator: { type: 'string', operation: 'equals' }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    position: [480, 600]
  }
});

const computeTelegramSlot = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Telegram Slot',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: computeTelegramSlotCode
    },
    position: [720, 600]
  },
  output: [{ slot: 'midday', source: 'telegram', chat_id: 0 }]
});

const cutoffResolver = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Resolve Cutoff',
    parameters: {
      operation: 'executeQuery',
      query: cutoffSQL,
      options: {
        queryReplacement: '={{ [$json.slot, $json.source, $json.chat_id] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [960, 400]
  },
  output: [{ briefing_date: '', slot: 'midday', source: 'scheduled', chat_id: null, cutoff_ts: '' }]
});

const fetchDelta = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Delta',
    parameters: {
      operation: 'executeQuery',
      query: deltaSQL,
      options: {
        queryReplacement: '={{ [$json.briefing_date, $json.slot, $json.source, $json.chat_id, $json.cutoff_ts] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [1200, 400]
  },
  output: [{ briefing_date: '', slot: 'midday', source: 'scheduled', chat_id: null, youtube_items: [], news_items: [], podcast_items: [], newsletter_items: [], frontier_briefings: [], gdelt_signal: [] }]
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: buildPromptCode
    },
    position: [1440, 400]
  },
  output: [{ skip: false, prompt: '', slot: 'midday', slotLabel: '午報', dateStr: '', total: 0, source: 'scheduled', chat_id: null, frontier: [] }]
});

const hasDelta = ifElse({
  version: 2.2,
  config: {
    name: 'Has Delta?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'cond-skip',
            leftValue: '={{ $json.skip }}',
            rightValue: false,
            operator: { type: 'boolean', operation: 'equals' }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    position: [1680, 400]
  }
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
    position: [1920, 300]
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
    position: [2160, 300]
  },
  output: [{ dateStr: '', slot: 'midday', slotLabel: '午報', source: 'scheduled', chat_id: null, markdown: '', prompt_tokens: 0, output_tokens: 0 }]
});

const saveBriefing = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Briefing',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO briefings (date, slot, markdown, prompt_tokens, output_tokens, generated_at) VALUES ($1::date, $2::text, $3, $4, $5, NOW()) ON CONFLICT (date, slot) DO UPDATE SET markdown = EXCLUDED.markdown, prompt_tokens = EXCLUDED.prompt_tokens, output_tokens = EXCLUDED.output_tokens, generated_at = NOW()",
      options: {
        queryReplacement: '={{ [$json.dateStr, $json.slot, $json.markdown, $json.prompt_tokens, $json.output_tokens] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [2400, 300]
  },
  output: [{}]
});

const isFromTelegram = ifElse({
  version: 2.2,
  config: {
    name: 'From Telegram?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'cond-source',
            leftValue: "={{ $('Combine Briefing').item.json.source }}",
            rightValue: 'telegram',
            operator: { type: 'string', operation: 'equals' }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    position: [2640, 300]
  }
});

const telegramReply = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram Reply',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: "={{ $('Combine Briefing').item.json.chat_id }}",
      text: "={{ '簡報已生成：' + $('Combine Briefing').item.json.dateStr + ' ' + $('Combine Briefing').item.json.slotLabel + '（更新）' }}",
      additionalFields: {}
    },
    position: [2880, 300]
  },
  output: [{}]
});

export default workflow('generate-briefing-update', 'Generate Briefing · Update')
  .add(middayCron).to(setMidday).to(cutoffResolver).to(fetchDelta).to(buildPrompt).to(
    hasDelta.onTrue(callSonnet.to(combineBriefing.to(saveBriefing.to(
      isFromTelegram.onTrue(telegramReply)
    ))))
  )
  .add(eveningCron).to(setEvening).to(cutoffResolver)
  .add(telegramTrigger_).to(
    filterUpdate.onTrue(computeTelegramSlot.to(cutoffResolver))
  );
