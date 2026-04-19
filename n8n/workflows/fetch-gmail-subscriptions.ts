import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const normalizeEmailCode = `const msg = $json;

// Robust header picker: handles (a) payload.headers array, (b) headers object,
// (c) top-level resolved fields returned as {text, value[]} or {address, name}.
const pickHeader = (name) => {
  const lower = name.toLowerCase();
  if (msg.payload && Array.isArray(msg.payload.headers)) {
    const h = msg.payload.headers.find(x => x && x.name && x.name.toLowerCase() === lower);
    if (h && h.value != null) return String(h.value);
  }
  if (msg.headers && typeof msg.headers === 'object') {
    const v = msg.headers[name] != null ? msg.headers[name] : msg.headers[lower];
    if (v != null) return String(v);
  }
  const top = msg[name] != null ? msg[name] : msg[name.charAt(0).toUpperCase() + name.slice(1)];
  if (top == null) return '';
  if (typeof top === 'string') return top;
  if (typeof top === 'object') {
    if (typeof top.text === 'string') return top.text;
    if (Array.isArray(top.value)) {
      return top.value.map(v => v.name ? v.name + ' <' + (v.address || '') + '>' : String(v.address || '')).join(', ');
    }
    if (top.address) return top.name ? top.name + ' <' + top.address + '>' : String(top.address);
  }
  return '';
};

const messageId = msg.id || msg.messageId || (msg.message && msg.message.id) || null;
const threadId  = msg.threadId || (msg.message && msg.message.threadId) || null;
const subject   = (pickHeader('subject') || '').trim() || '(no subject)';
const from      = pickHeader('from') || '';
const dateHdr   = pickHeader('date') || '';

if (!messageId) {
  return { json: { _error: 'missing message id', _keys: Object.keys(msg) } };
}

let senderEmail = '', senderName = null;
const fromMatch = from.match(/^([^<]*)<([^>]+)>/);
if (fromMatch) {
  senderName  = fromMatch[1].replace(/["']/g, '').trim() || null;
  senderEmail = fromMatch[2].trim().toLowerCase();
} else {
  senderEmail = from.trim().toLowerCase();
}

let bodyText = null, bodyHtml = null;
if (msg.text || msg.html) {
  bodyText = (msg.text || '') || null;
  bodyHtml = (msg.html || '') || null;
} else if (msg.payload) {
  function walkParts(part) {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    if (mime === 'text/plain' && !bodyText && part.body && part.body.data) {
      bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (mime === 'text/html' && !bodyHtml && part.body && part.body.data) {
      bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walkParts);
  }
  walkParts(msg.payload);
}

if (!bodyText && bodyHtml) {
  bodyText = bodyHtml
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\s+/g, ' ')
    .trim();
}
if (!bodyText) bodyText = msg.snippet || '';

const bodyForPrompt = (bodyText || '').substring(0, 40000);

let receivedAt = null;
if (dateHdr) {
  const parsed = new Date(dateHdr);
  if (!isNaN(parsed.getTime())) receivedAt = parsed.toISOString();
} else if (msg.internalDate) {
  receivedAt = new Date(parseInt(msg.internalDate)).toISOString();
}

const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
const labelsLiteral = '{' + labelIds.map(l => '"' + String(l).replace(/"/g, '') + '"').join(',') + '}';

const userContent = [
  'Subject: ' + subject,
  'From: ' + (senderName ? senderName + ' <' + (senderEmail || '') + '>' : (senderEmail || '')),
  '',
  bodyForPrompt
].join('\\n');

return {
  json: {
    message_id:     messageId,
    thread_id:      threadId,
    sender_email:   senderEmail || null,
    sender_name:    senderName,
    subject:        subject,
    labels_literal: labelsLiteral,
    received_at:    receivedAt,
    user_content:   userContent
  }
};`;

const parseClaudeResponseCode = `const response = $json;
const src = $('Normalize Email').item.json;
if (!src || !src.message_id) return { json: { skip: true } };

let raw = '';
if (response && Array.isArray(response.content) && response.content.length > 0) {
  raw = response.content[0].text || '';
}
raw = raw.trim();

if (raw.startsWith('\\u0060\\u0060\\u0060')) {
  raw = raw.replace(/^\\u0060\\u0060\\u0060(?:json)?\\s*/i, '').replace(/\\u0060\\u0060\\u0060\\s*$/i, '').trim();
}

let parsed = null;
try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

let summaryMarkdown;
if (parsed && typeof parsed === 'object') {
  const lines = [];
  if (parsed.summary) lines.push(String(parsed.summary).trim());
  if (Array.isArray(parsed.themes) && parsed.themes.length) {
    lines.push('', '## Themes');
    parsed.themes.forEach(t => lines.push('- ' + String(t).trim()));
  }
  if (Array.isArray(parsed.key_facts) && parsed.key_facts.length) {
    lines.push('', '## Key Facts');
    parsed.key_facts.forEach(f => lines.push('- ' + String(f).trim()));
  }
  summaryMarkdown = lines.join('\\n').trim() || null;
} else {
  summaryMarkdown = raw || null;
}

return {
  json: {
    message_id:     src.message_id,
    thread_id:      src.thread_id,
    sender_email:   src.sender_email,
    sender_name:    src.sender_name,
    subject:        src.subject,
    summary:        summaryMarkdown,
    labels_literal: src.labels_literal,
    received_at:    src.received_at
  }
};`;

const buildHaikuZhCode = `const src = $json;
if (!src || !src.message_id || !src.subject) return { json: { skip: true } };

const title = String(src.subject).trim();
if (!title) return { json: { skip: true } };

function cleanText(text) {
  if (!text) return '';
  text = text.replace(/https?:\\/\\/\\S+/g, '');
  text = text.replace(/#\\S+/g, '');
  const pats = [/unsubscribe.*/gi, /view (this|it) in your browser.*/gi, /click here.*/gi, /manage preferences.*/gi, /you'?re receiving this.*/gi];
  for (let i = 0; i < pats.length; i++) text = text.replace(pats[i], '');
  text = text.replace(/\\n{3,}/g, '\\n\\n');
  return text.split('\\n').filter(l => l.trim().length > 2).join('\\n').trim();
}

let content = cleanText(src.summary || '');
if (content.length > 1200) content = content.substring(0, 1200) + '...';

const prompt = '你是一位香港時事分析助手。請根據以下電子報資料，用繁體中文完成兩項任務：\\n\\n1. 撮要：用1至2句話概括內容的核心，風格簡潔如新聞標題。可參考標題及內容摘要。\\n2. 關鍵詞：只根據「標題」提取5至8個最重要的繁體中文關鍵詞（人名、地名、事件、議題等），不要從其他參考資料中提取。\\n\\n請以下列JSON格式回覆，不要加任何其他文字：\\n{\\n  "summary_zh": "...",\\n  "keywords_zh": ["...", "...", "..."]\\n}\\n\\n標題：' + title + '\\n\\n其他參考資料（只用於撮要，不用於關鍵詞）：\\n' + content;

return {
  json: {
    item_type: 'newsletter',
    item_id:   src.message_id,
    prompt:    prompt
  }
};`;

const parseHaikuZhCode = `const response = $json;
const src = $('Build Haiku Zh Prompt').item.json;
if (!src || src.skip) return { json: { skip: true } };

let content = '';
if (response && Array.isArray(response.content) && response.content.length > 0) {
  content = response.content[0].text || '';
}
content = content.trim();
if (!content) return { json: { skip: true, item_type: src.item_type, item_id: src.item_id } };

if (content.indexOf('\\u0060\\u0060\\u0060') === 0) {
  const lines = content.split('\\n');
  const filtered = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('\\u0060\\u0060\\u0060') !== 0) filtered.push(lines[i]);
  }
  content = filtered.join('\\n').trim();
}

let result;
try { result = JSON.parse(content); }
catch (e) { return { json: { skip: true, item_type: src.item_type, item_id: src.item_id, error: 'JSON parse failed' } }; }

const summaryZh  = result.summary_zh || null;
const keywordsZh = Array.isArray(result.keywords_zh) ? result.keywords_zh : (result.keywords_zh ? [result.keywords_zh] : []);
const keywordsLiteral = '{' + keywordsZh.map(k => '"' + String(k).replace(/"/g, '') + '"').join(',') + '}';

return {
  json: {
    item_type:        src.item_type,
    item_id:          src.item_id,
    summary_zh:       summaryZh,
    keywords_literal: keywordsLiteral
  }
};`;

const everyHour = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every hour',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 * * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchSubscriptionEmails = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.1,
  config: {
    name: 'Fetch Subscription Emails',
    parameters: {
      resource: 'message',
      operation: 'getAll',
      returnAll: true,
      simple: false,
      filters: {
        q: 'label:Subscription',
        includeSpamTrash: false
      },
      options: {
        downloadAttachments: false
      }
    },
    credentials: { gmailOAuth2: newCredential('Gmail OAuth2') },
    position: [480, 300]
  },
  output: [{ id: 'msg-id', threadId: 'thread-id' }]
});

const normalizeEmail = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Email',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: normalizeEmailCode
    },
    position: [720, 300]
  },
  output: [{ message_id: '', subject: '', user_content: '' }]
});

const callClaudeHaiku = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call Claude Haiku',
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
      jsonBody: '={{ JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1024, system: [{ type: "text", text: "You summarize subscription newsletter emails. Strip out marketing copy, sponsor mentions, ads, social-media footers, unsubscribe links, and boilerplate. Keep only substantive content. Respond in the same language as the input email. Output valid JSON with this exact shape and nothing else: {\\"summary\\": \\"<1-2 sentence core message>\\", \\"themes\\": [\\"<short theme>\\", ...], \\"key_facts\\": [\\"<concrete fact with numbers/names/dates>\\", ...]}. Use 3-6 themes and 3-8 key_facts. If the email has no substance (pure promo/ad), return {\\"summary\\": \\"(promotional content only)\\", \\"themes\\": [], \\"key_facts\\": []}.", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: $json.user_content }] }) }}',
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 500 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 60000
      }
    },
    credentials: { httpHeaderAuth: newCredential('Anthropic API Key') },
    onError: 'continueRegularOutput',
    position: [960, 300]
  },
  output: [{ content: [{ text: '' }] }]
});

const parseClaudeResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Claude Response',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: parseClaudeResponseCode
    },
    position: [1200, 300]
  },
  output: [{ message_id: '', summary: '' }]
});

const saveSubscriptionItem = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Subscription Item',
    parameters: {
      operation: 'executeQuery',
      query: 'INSERT INTO newsletter_items (message_id, thread_id, sender_email, sender_name, subject, summary, labels, received_at) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::timestamptz) ON CONFLICT (message_id) DO UPDATE SET summary = COALESCE(EXCLUDED.summary, newsletter_items.summary)',
      options: {
        queryReplacement: '={{ [$json.message_id, $json.thread_id, $json.sender_email, $json.sender_name, $json.subject, $json.summary, $json.labels_literal, $json.received_at] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    position: [1440, 300]
  },
  output: [{}]
});

const moveToTrash = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.1,
  config: {
    name: 'Move to Trash',
    parameters: {
      resource: 'message',
      operation: 'delete',
      messageId: "={{ $('Parse Claude Response').item.json.message_id }}"
    },
    credentials: { gmailOAuth2: newCredential('Gmail OAuth2') },
    onError: 'continueRegularOutput',
    position: [1680, 200]
  },
  output: [{}]
});

const buildHaikuZhPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Haiku Zh Prompt',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: buildHaikuZhCode
    },
    position: [1680, 460]
  },
  output: [{ item_type: 'newsletter', item_id: '', prompt: '' }]
});

const callClaudeHaikuZh = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call Claude Haiku Zh',
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
      jsonBody: '={{ JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 256, messages: [{ role: "user", content: $json.prompt }] }) }}',
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 500 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 30000
      }
    },
    credentials: { httpHeaderAuth: newCredential('Anthropic API Key') },
    onError: 'continueRegularOutput',
    position: [1920, 460]
  },
  output: [{ content: [{ text: '' }] }]
});

const parseHaikuZhResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Haiku Zh Response',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: parseHaikuZhCode
    },
    position: [2160, 460]
  },
  output: [{ item_type: 'newsletter', item_id: '', summary_zh: '', keywords_literal: '{}' }]
});

const saveEnrichment = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Enrichment',
    parameters: {
      operation: 'executeQuery',
      query: 'INSERT INTO item_enrichment (item_type, item_id, summary_zh, keywords_zh, processed_at) VALUES ($1, $2, $3, $4::text[], NOW()) ON CONFLICT (item_type, item_id) DO UPDATE SET summary_zh = EXCLUDED.summary_zh, keywords_zh = EXCLUDED.keywords_zh, processed_at = NOW()',
      options: {
        queryReplacement: '={{ [$json.item_type, $json.item_id, $json.summary_zh, $json.keywords_literal] }}'
      }
    },
    credentials: { postgres: newCredential('Railway') },
    onError: 'continueRegularOutput',
    position: [2400, 460]
  },
  output: [{}]
});

export default workflow('fetch-gmail-subscriptions', 'Fetch Gmail Subscriptions')
  .add(everyHour)
  .to(fetchSubscriptionEmails)
  .to(normalizeEmail)
  .to(callClaudeHaiku)
  .to(parseClaudeResponse)
  .to(saveSubscriptionItem)
  .to(moveToTrash)
  .add(saveSubscriptionItem)
  .to(buildHaikuZhPrompt)
  .to(callClaudeHaikuZh)
  .to(parseHaikuZhResponse)
  .to(saveEnrichment);
