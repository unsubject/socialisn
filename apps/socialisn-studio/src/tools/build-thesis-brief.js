import { z } from 'zod';
import { pool } from '../db.js';

const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-5';
const SONNET_TIMEOUT_MS = 90_000;
const PERPLEXITY_TIMEOUT_MS = 30_000;

const InputSchema = {
  subject: z
    .string()
    .min(1)
    .describe('The subject/topic to build a thesis around (free text; Chinese or English both fine).'),
  user_direction: z
    .string()
    .min(1)
    .describe('The user\'s rough angle or direction — a sentence or paragraph. Sonnet will sharpen this into a thesis.'),
  window_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(168)
    .describe('Corpus look-back window. Default 168 hours (1 week).'),
  corpus_limit: z
    .number()
    .int()
    .positive()
    .max(30)
    .default(12)
    .describe('Max corpus items to pass to Sonnet. Default 12.')
};

const CORPUS_SQL = `
WITH hits AS (
  SELECT 'newsletter'::text AS source_type,
         nl.message_id      AS id,
         nl.subject         AS title,
         nl.sender_name     AS source_name,
         NULL::text         AS url,
         nl.fetched_at,
         nl.received_at     AS published_at,
         nl.summary         AS excerpt,
         e.summary_zh,
         e.keywords_zh
    FROM newsletter_items nl
    LEFT JOIN item_enrichment e
      ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
   WHERE nl.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       nl.subject ILIKE $2
       OR COALESCE(nl.summary, '') ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'news'::text, n.article_id, n.headline, n.source_name, n.url,
         n.fetched_at, n.published_at, n.excerpt, e.summary_zh, e.keywords_zh
    FROM news_items n
    LEFT JOIN item_enrichment e
      ON e.item_type = 'news' AND e.item_id = n.article_id
   WHERE n.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       n.headline ILIKE $2
       OR COALESCE(n.excerpt, '') ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'youtube'::text, y.video_id, y.title, y.channel_name,
         'https://www.youtube.com/watch?v=' || y.video_id,
         y.fetched_at, y.published_at, NULL, e.summary_zh, e.keywords_zh
    FROM youtube_items y
    LEFT JOIN item_enrichment e
      ON e.item_type = 'youtube' AND e.item_id = y.video_id
   WHERE y.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       y.title ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'podcast'::text, p.episode_id, p.title, p.podcast_name, p.episode_url,
         p.fetched_at, p.published_at, NULL, e.summary_zh, e.keywords_zh
    FROM podcast_items p
    LEFT JOIN item_enrichment e
      ON e.item_type = 'podcast' AND e.item_id = p.episode_id
   WHERE p.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       p.title ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
)
SELECT source_type, id, title, source_name, url, fetched_at, published_at,
       excerpt, summary_zh
  FROM hits
 ORDER BY fetched_at DESC
 LIMIT $3
`;

function escapeLikeLiteral(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function gatherCorpusEvidence(subject, windowHours, limit) {
  const pattern = `%${escapeLikeLiteral(subject)}%`;
  const { rows } = await pool.query(CORPUS_SQL, [windowHours, pattern, limit]);
  return rows;
}

async function gatherPerplexityEvidence(subject, userDirection) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;
  const res = await fetchWithTimeout(
    'https://api.perplexity.ai/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content:
              'You are a research assistant gathering factual, sourced evidence for a thesis brief. Return concrete facts, data, documented statements, and studies relevant to the subject and the stated angle. Include both corroborating facts AND facts that complicate the angle. Be concise and cite sources inline.'
          },
          {
            role: 'user',
            content: `Subject: ${subject}\n\nAngle/direction: ${userDirection}\n\nReturn the most important verifiable facts from roughly the last week, with sources.`
          }
        ],
        search_recency_filter: 'week',
        return_citations: true,
        web_search_options: { search_context_size: 'medium' },
        temperature: 0.1
      })
    },
    PERPLEXITY_TIMEOUT_MS
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Perplexity ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const citations = Array.isArray(data?.citations) ? data.citations : [];
  return { content, citations };
}

function formatCorpusItem(item, i) {
  const lines = [`${i + 1}. 【${item.source_type}｜${item.source_name || '來源未知'}】`];
  lines.push(`標題：${item.title || ''}`);
  if (item.summary_zh) {
    lines.push(`摘要（繁）：${item.summary_zh}`);
  } else if (item.excerpt) {
    lines.push(`摘要：${String(item.excerpt).slice(0, 400)}`);
  }
  if (item.published_at) {
    const iso = item.published_at instanceof Date
      ? item.published_at.toISOString()
      : new Date(item.published_at).toISOString();
    lines.push(`日期：${iso.slice(0, 10)}`);
  }
  if (item.url) lines.push(`連結：${item.url}`);
  return lines.join('\n');
}

function buildPrompt({ subject, userDirection, corpus, perplexity, windowHours }) {
  const corpusBlock =
    corpus.length > 0
      ? corpus.map(formatCorpusItem).join('\n\n---\n\n')
      : '（語料庫內暫無相關內容）';
  const perplexityBlock = perplexity
    ? `${perplexity.content}\n\n引用連結：\n${(perplexity.citations || [])
        .map((c, i) => `[${i + 1}] ${c}`)
        .join('\n')}`
    : '（Perplexity 研究不可用 — 未配置 API 金鑰或請求失敗）';

  return (
    '你是利世民的論述助理。利世民是一位香港古典自由主義評論員，立場理性、重證據、與情緒化的主流論述持反向角度。書寫語言為繁體中文、粵語口語化。觀眾偏好排序：宏觀經濟 > 香港 > 歷史。\n\n' +
    '你的任務：根據使用者提供的「主題」和「取向」，以及下列語料資料，為利世民構建一個節目論述簡報。\n\n' +
    '【關鍵規則（必須遵守）】\n' +
    '1. 「反向證據」絕不等於「反駁論點」。列出的反向證據必須是「事實、數據、研究或有據可查的聲明」；絕不是修辭式反對，也不是「有人認為」之類的含糊說法。每項反向證據都必須附具體來源（語料項目或 Perplexity 引用）。\n' +
    '2. 不要美化、不要填充。若證據不足以支持一項論點，寧可寫得短一些。\n' +
    '3. 所有文字欄位用繁體中文（粵語口語）；連結和日期保持原樣。\n\n' +
    '【主題】\n' +
    subject +
    '\n\n【取向（使用者角度）】\n' +
    userDirection +
    `\n\n【語料資料：Socialisn 過去 ${windowHours} 小時內相關項目】\n` +
    corpusBlock +
    '\n\n【Perplexity 即時網絡研究】\n' +
    perplexityBlock +
    '\n\n【輸出格式】\n' +
    '只輸出下列結構的 JSON，不要任何前言、說明、Markdown 圍欄、或其他文字。\n\n' +
    '{\n' +
    '  "sharpened_thesis": "經打磨的立論（100-200 字，繁體中文）",\n' +
    '  "supporting_evidence": [\n' +
    '    { "fact": "簡短事實（繁體中文一句）", "source": "來源名稱", "url": "連結或 null", "date": "YYYY-MM-DD 或 null", "origin": "corpus 或 perplexity" }\n' +
    '  ],\n' +
    '  "counter_evidence": [\n' +
    '    { "fact": "令立論複雜化的事實", "source": "...", "url": "...", "date": "...", "origin": "..." }\n' +
    '  ],\n' +
    '  "collapses_if": "若以下事實成立，這個角度即需推翻：一句話，繁體中文"\n' +
    '}\n\n' +
    'supporting_evidence 3-5 項；counter_evidence 2-4 項。'
  );
}

async function callSonnet(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for build_thesis_brief');
  }
  const model = process.env.STUDIO_SONNET_MODEL || DEFAULT_SONNET_MODEL;
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }]
      })
    },
    SONNET_TIMEOUT_MS
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text || '';
  return { text, usage: data?.usage || null, model };
}

function parseJsonFromSonnet(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Sonnet output did not contain a JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function registerBuildThesisBrief(server) {
  server.registerTool(
    'build_thesis_brief',
    {
      title: 'Build thesis brief',
      description:
        'Given a subject and the user\'s rough angle, returns a sharpened thesis + 3-5 supporting evidence items + 2-4 counter-evidence items (facts that complicate, never rhetorical opposition) + one "collapses if" risk line. Synthesizes the socialisn Postgres corpus (last window_hours hours) with fresh Perplexity web research. Output text is Traditional Chinese (Cantonese idiom). Requires ANTHROPIC_API_KEY; PERPLEXITY_API_KEY is optional — corpus-only brief is generated if it\'s missing. Sonnet model is configurable via STUDIO_SONNET_MODEL env var (default claude-sonnet-4-5).',
      inputSchema: InputSchema
    },
    async ({ subject, user_direction, window_hours, corpus_limit }) => {
      const corpus = await gatherCorpusEvidence(subject, window_hours, corpus_limit);

      let perplexity = null;
      let perplexityError = null;
      try {
        perplexity = await gatherPerplexityEvidence(subject, user_direction);
      } catch (err) {
        perplexityError = err.message;
      }

      const prompt = buildPrompt({
        subject,
        userDirection: user_direction,
        corpus,
        perplexity,
        windowHours: window_hours
      });

      const sonnet = await callSonnet(prompt);
      const brief = parseJsonFromSonnet(sonnet.text);

      const payload = {
        subject,
        user_direction,
        window_hours,
        corpus_items_used: corpus.length,
        perplexity_available: perplexity !== null,
        perplexity_citations: perplexity?.citations?.length || 0,
        perplexity_error: perplexityError,
        sonnet_model: sonnet.model,
        usage: sonnet.usage,
        sharpened_thesis: brief.sharpened_thesis,
        supporting_evidence: brief.supporting_evidence || [],
        counter_evidence: brief.counter_evidence || [],
        collapses_if: brief.collapses_if
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      };
    }
  );
}
