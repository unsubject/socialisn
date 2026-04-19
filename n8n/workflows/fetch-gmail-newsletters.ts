import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

// Runs every 3 hours and pulls all emails with a List-Unsubscribe header
// (the RFC 2369 marker that identifies genuine newsletter/mailing-list traffic).
// Deduplication is handled by ON CONFLICT (message_id) DO NOTHING in Postgres.

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 3 hours',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 */3 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchEmails = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.1,
  config: {
    name: 'Fetch Newsletter Emails',
    parameters: {
      resource: 'message',
      operation: 'getAll',
      returnAll: false,
      limit: 100,
      filters: {
        // has:list-unsubscribe matches any email carrying the List-Unsubscribe
        // header required by RFC 2369 — the most reliable newsletter signal.
        // newer_than:3d gives a 50% overlap window so we never miss an email
        // even if a run is delayed or skipped.
        q: 'has:list-unsubscribe newer_than:3d',
        includeSpamTrash: false
      },
      options: {
        downloadAttachments: false
      }
    },
    credentials: { gmailOAuth2: newCredential('Gmail OAuth2') },
    position: [480, 300]
  },
  output: [
    {
      id: 'msg001',
      threadId: 'thread001',
      snippet: 'Weekly digest content...',
      subject: 'Weekly Digest #42',
      from: 'Example Newsletter <newsletter@example.com>',
      date: '2026-04-18T09:00:00Z',
      labelIds: ['INBOX', 'CATEGORY_PROMOTIONS']
    }
  ]
});

const normalize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Email',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: [
        "const msg = $json;",
        "const messageId = msg.id;",
        "if (!messageId) return { json: {} };",
        "",
        "// Extract headers — handle both simplified (top-level fields) and",
        "// full MIME (payload.headers array) response shapes from the Gmail node.",
        "let subject = '', from = '', date = '';",
        "if (msg.payload && Array.isArray(msg.payload.headers)) {",
        "  for (const h of msg.payload.headers) {",
        "    const n = h.name.toLowerCase();",
        "    if (n === 'subject') subject = h.value;",
        "    else if (n === 'from') from = h.value;",
        "    else if (n === 'date') date = h.value;",
        "  }",
        "} else {",
        "  subject = msg.subject || '';",
        "  from    = msg.from    || '';",
        "  date    = msg.date    || '';",
        "}",
        "",
        "// Parse sender",
        "let senderEmail = '', senderName = null;",
        "const fromMatch = from.match(/^([^<]*)<([^>]+)>/);",
        "if (fromMatch) {",
        "  senderName  = fromMatch[1].replace(/[\"\']/g, '').trim() || null;",
        "  senderEmail = fromMatch[2].trim().toLowerCase();",
        "} else {",
        "  senderEmail = from.trim().toLowerCase();",
        "}",
        "if (!senderEmail) return { json: {} };",
        "",
        "// Extract body — simplified format exposes .text / .html directly;",
        "// full MIME format requires walking payload.parts recursively.",
        "let bodyText = null, bodyHtml = null;",
        "if (msg.text || msg.html) {",
        "  bodyText = (msg.text  || msg.snippet || '').substring(0, 20000) || null;",
        "  bodyHtml = (msg.html  || '').substring(0, 200000)              || null;",
        "} else if (msg.payload) {",
        "  function walkParts(part) {",
        "    if (!part) return;",
        "    const mime = (part.mimeType || '').toLowerCase();",
        "    if (mime === 'text/plain' && !bodyText && part.body && part.body.data) {",
        "      bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8').substring(0, 20000);",
        "    }",
        "    if (mime === 'text/html' && !bodyHtml && part.body && part.body.data) {",
        "      bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf-8').substring(0, 200000);",
        "    }",
        "    if (Array.isArray(part.parts)) part.parts.forEach(walkParts);",
        "  }",
        "  walkParts(msg.payload);",
        "  if (!bodyText) bodyText = (msg.snippet || '').substring(0, 20000) || null;",
        "}",
        "",
        "// Parse received date",
        "let receivedAt = null;",
        "if (date) {",
        "  const parsed = new Date(date);",
        "  if (!isNaN(parsed.getTime())) receivedAt = parsed.toISOString();",
        "} else if (msg.internalDate) {",
        "  receivedAt = new Date(parseInt(msg.internalDate)).toISOString();",
        "}",
        "",
        "// Build Postgres array literal for the labels column",
        "const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];",
        "const labelsLiteral = '{' + labelIds.map(l => '\"' + String(l).replace(/\"/g, '') + '\"').join(',') + '}';",
        "",
        "return {",
        "  json: {",
        "    message_id:   messageId,",
        "    thread_id:    msg.threadId || null,",
        "    sender_email: senderEmail,",
        "    sender_name:  senderName,",
        "    subject:      subject.trim() || '(no subject)',",
        "    body_text:    bodyText,",
        "    body_html:    bodyHtml,",
        "    labels_literal: labelsLiteral,",
        "    received_at:  receivedAt",
        "  }",
        "};"
      ].join('\n')
    },
    position: [720, 300]
  },
  output: [
    {
      message_id: 'msg001',
      thread_id: 'thread001',
      sender_email: 'newsletter@example.com',
      sender_name: 'Example Newsletter',
      subject: 'Weekly Digest #42',
      body_text: 'Content preview...',
      body_html: null,
      labels_literal: '{"INBOX","CATEGORY_PROMOTIONS"}',
      received_at: '2026-04-18T09:00:00Z'
    }
  ]
});

const saveItem = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Newsletter Item',
    parameters: {
      operation: 'executeQuery',
      query: [
        'INSERT INTO newsletter_items',
        '  (message_id, thread_id, sender_email, sender_name, subject, body_text, body_html, labels, received_at)',
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::timestamptz)',
        'ON CONFLICT (message_id) DO NOTHING'
      ].join(' '),
      options: {
        queryReplacement: expr(
          '{{ [' +
          '$json.message_id, $json.thread_id, $json.sender_email, $json.sender_name, ' +
          '$json.subject, $json.body_text, $json.body_html, $json.labels_literal, $json.received_at' +
          '] }}'
        )
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [960, 300]
  },
  output: [{}]
});

export default workflow('fetch-gmail-newsletters', 'Fetch Gmail Newsletters')
  .add(schedule)
  .to(fetchEmails)
  .to(normalize)
  .to(saveItem);
