import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 6 Hours (offset)',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '45 4,10,16,22 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchUnenriched = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Unenriched Items',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT 'youtube' AS item_type, video_id AS item_id, title, COALESCE(description, '') AS text1, COALESCE(transcript_text, '') AS text2 FROM youtube_items WHERE fetched_at >= NOW() - INTERVAL '48 hours' AND NOT EXISTS (SELECT 1 FROM item_enrichment e WHERE e.item_type = 'youtube' AND e.item_id = video_id) UNION ALL SELECT 'news', article_id, headline, COALESCE(excerpt, ''), COALESCE(full_text, '') FROM news_items WHERE fetched_at >= NOW() - INTERVAL '48 hours' AND NOT EXISTS (SELECT 1 FROM item_enrichment e WHERE e.item_type = 'news' AND e.item_id = article_id) UNION ALL SELECT 'podcast', episode_id, title, COALESCE(description, ''), '' FROM podcast_items WHERE fetched_at >= NOW() - INTERVAL '48 hours' AND NOT EXISTS (SELECT 1 FROM item_enrichment e WHERE e.item_type = 'podcast' AND e.item_id = episode_id)"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [{ item_type: 'youtube', item_id: 'abc123', title: 'Video Title', text1: 'Description here', text2: '' }]
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Nano Prompt',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "var item = $json;\nvar itemType = item.item_type;\nvar title = (item.title || '').trim();\nif (!title) return { json: { skip: true } };\nfunction cleanText(text) {\n  if (!text) return '';\n  text = text.replace(/https?:\\/\\/\\S+/g, '');\n  text = text.replace(/#\\S+/g, '');\n  var pats = [/patreon.*/gi, /buymeacoffee.*/gi, /nordvpn.*/gi, /課金支持.*/gi, /支持.*頻道.*/gi, /訂閱.*頻道.*/gi, /成為.*會員.*/gi, /優惠碼.*/gi, /discount code.*/gi, /promo code.*/gi, /affiliate.*/gi, /請我.*咖啡.*/gi, /ig:.*/gi, /fb:.*/gi, /twitter:.*/gi, /mewe:.*/gi, /telegram:.*/gi];\n  for (var i = 0; i < pats.length; i++) text = text.replace(pats[i], '');\n  text = text.replace(/\\n{3,}/g, '\\n\\n');\n  return text.split('\\n').filter(function(l) { return l.trim().length > 2; }).join('\\n').trim();\n}\nvar text1 = cleanText(item.text1 || '');\nif (text1.length > 600) text1 = text1.substring(0, 600) + '...';\nvar text2 = cleanText(item.text2 || '');\nif (text2.length > 600) text2 = text2.substring(0, 600) + '...';\nvar parts = [];\nif (text1) parts.push(text1);\nif (text2) parts.push(text2);\nvar content = parts.join('\\n\\n');\nvar labels = { youtube: ['YouTube影片', '標題、簡介及字幕'], news: ['新聞文章', '標題、摘要及全文'], podcast: ['Podcast節目', '標題及節目描述'] };\nvar lb = labels[itemType] || ['資料', '標題及內容'];\nvar prompt = '你是一位香港時事分析助手。請根據以下' + lb[0] + '資料，用繁體中文完成兩項任務：\\n\\n1. 撮要：用1至2句話概括內容的核心，風格簡潔如新聞標題。可參考' + lb[1] + '。\\n2. 關鍵詞：只根據「標題」提取5至8個最重要的繁體中文關鍵詞（人名、地名、事件、議題等），不要從其他參考資料中提取。\\n\\n請以下列JSON格式回覆，不要加任何其他文字：\\n{\\n  \"summary_zh\": \"...\",\\n  \"keywords_zh\": [\"...\", \"...\", \"...\"]\\n}\\n\\n標題：' + title + '\\n\\n其他參考資料（只用於撮要，不用於關鍵詞）：\\n' + content;\nreturn { json: { item_type: itemType, item_id: item.item_id, prompt: prompt } };"
    },
    position: [720, 300]
  },
  output: [{ item_type: 'youtube', item_id: 'abc123', prompt: '你是一位香港時事分析助手...' }]
});

const callNano = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call OpenAI Nano',
    parameters: {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({ model: "gpt-5.4-nano", max_completion_tokens: 256, messages: [{ role: "user", content: $json.prompt }] }) }}'),
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 500 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 30000
      }
    },
    credentials: { httpHeaderAuth: newCredential('OpenAI API Key') },
    onError: 'continueRegularOutput',
    position: [960, 300]
  },
  output: [{ id: 'chatcmpl-123', choices: [{ message: { role: 'assistant', content: '{"summary_zh": "香港金融市場今日表現強勁", "keywords_zh": ["香港", "金融市場", "恒指"]}' } }], model: 'gpt-5.4-nano', usage: { prompt_tokens: 100, completion_tokens: 50 } }]
});

const parseResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Nano Response',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "var response = $json;\nvar src = $(\"Build Nano Prompt\").item.json;\nif (!src || src.skip) return { json: { skip: true } };\nvar content = '';\nif (response.choices && response.choices.length > 0 && response.choices[0].message) {\n  content = response.choices[0].message.content || '';\n}\ncontent = content.trim();\nif (!content) return { json: { skip: true, item_type: src.item_type, item_id: src.item_id } };\nif (content.indexOf('```') === 0) {\n  var lines = content.split('\\n');\n  var filtered = [];\n  for (var i = 0; i < lines.length; i++) {\n    if (lines[i].indexOf('```') !== 0) filtered.push(lines[i]);\n  }\n  content = filtered.join('\\n').trim();\n}\nvar result;\ntry {\n  result = JSON.parse(content);\n} catch (e) {\n  return { json: { skip: true, item_type: src.item_type, item_id: src.item_id, error: 'JSON parse failed' } };\n}\nvar summaryZh = result.summary_zh || null;\nvar keywordsZh = Array.isArray(result.keywords_zh) ? result.keywords_zh : (result.keywords_zh ? [result.keywords_zh] : []);\nvar keywordsLiteral = '{' + keywordsZh.map(function(k) { return '\"' + String(k).replace(/\"/g, '') + '\"'; }).join(',') + '}';\nreturn { json: { item_type: src.item_type, item_id: src.item_id, summary_zh: summaryZh, keywords_literal: keywordsLiteral } };"
    },
    position: [1200, 300]
  },
  output: [{ item_type: 'youtube', item_id: 'abc123', summary_zh: '香港金融市場今日表現強勁', keywords_literal: '{"香港","金融市場","恒指"}' }]
});

const saveEnrichment = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Enrichment',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO item_enrichment (item_type, item_id, summary_zh, keywords_zh, processed_at) VALUES ($1, $2, $3, $4::text[], NOW()) ON CONFLICT (item_type, item_id) DO UPDATE SET summary_zh = EXCLUDED.summary_zh, keywords_zh = EXCLUDED.keywords_zh, processed_at = NOW()",
      options: {
        queryReplacement: expr('={{ [$json.item_type, $json.item_id, $json.summary_zh, $json.keywords_literal] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1440, 300]
  },
  output: [{}]
});

export default workflow('process-haiku', 'Process Items with Nano')
  .add(schedule)
  .to(fetchUnenriched)
  .to(buildPrompt)
  .to(callNano)
  .to(parseResponse)
  .to(saveEnrichment);
