import { z } from 'zod';

const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-5';
const SONNET_TIMEOUT_MS = 180_000;
const MAX_TOKENS = 16000;

const factShape = z.object({
  fact: z.string(),
  source: z.string().optional(),
  url: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  origin: z.string().optional()
});

const flexibleFact = z.union([z.string(), factShape]);

const InputSchema = {
  subject: z
    .string()
    .min(1)
    .describe('The subject. Free text, Chinese or English.'),
  thesis: z
    .string()
    .min(1)
    .describe(
      'The sharpened thesis (typically from build_thesis_brief.sharpened_thesis).'
    ),
  key_facts: z
    .array(flexibleFact)
    .min(1)
    .describe(
      'Supporting facts/evidence. Plain strings or {fact, source, url, date, origin} objects (as returned by build_thesis_brief.supporting_evidence).'
    ),
  counter_evidence: z
    .array(flexibleFact)
    .optional()
    .describe(
      'Counter-facts to acknowledge and integrate in section 5. Typically from build_thesis_brief.counter_evidence. Must be facts, not rhetorical opposition.'
    ),
  collapses_if: z
    .string()
    .optional()
    .describe(
      'The "angle collapses if..." risk line. Typically from build_thesis_brief.collapses_if; used to ground section 5.'
    ),
  track: z
    .enum(['youtube', 'podcast'])
    .describe(
      'Content track. "youtube" = broad-reach broadcast ending with a members-conversion CTA. "podcast" = members deep-dive ending with a curiosity hook for the next members episode.'
    ),
  duration_min: z
    .number()
    .int()
    .positive()
    .max(120)
    .default(30)
    .describe('Target duration in minutes. Default 30. Character target is 150–200 chars/min.')
};

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFact(f) {
  if (typeof f === 'string') return { fact: f };
  return f;
}

function formatFactList(facts) {
  return facts
    .map((raw, i) => {
      const f = normalizeFact(raw);
      const lines = [`${i + 1}. ${f.fact}`];
      const meta = [];
      if (f.source) meta.push(`來源：${f.source}`);
      if (f.date) meta.push(`日期：${f.date}`);
      if (f.url) meta.push(`連結：${f.url}`);
      if (meta.length) lines.push('   ' + meta.join('；'));
      return lines.join('\n');
    })
    .join('\n');
}

function buildPrompt({
  subject,
  thesis,
  key_facts,
  counter_evidence,
  collapses_if,
  track,
  duration_min
}) {
  const minChars = Math.round(duration_min * 150);
  const maxChars = Math.round(duration_min * 200);
  const keyFactsBlock = formatFactList(key_facts);
  const counterBlock =
    counter_evidence && counter_evidence.length > 0
      ? formatFactList(counter_evidence)
      : '（未提供反向證據 — 第五節可簡短帶過或基於立論本身的邊界條件）';
  const collapseBlock = collapses_if ? `若以下事實成立立論需推翻：${collapses_if}` : '';
  const trackLabel = track === 'youtube' ? 'YouTube 廣播' : 'Podcast 會員深度';
  const ctaGuidance =
    track === 'youtube'
      ? '結尾 CTA：一句話總結立論，然後為會員獨家內容做預告/轉化 call（「如果你想更深入這個議題 / 要看更多數據 / 要聽我更完整的分析，請加入會員…」）'
      : '結尾 CTA：一句話總結立論，然後勾起對下一集會員深度內容的好奇心（「這個題目還有一個我還沒講的面向，下集會員內容告訴你…」「下集我會深入…」）';

  return (
    '你是利世民的節目腳本撰稿員。\n\n' +
    '【角色與語氣】\n' +
    '- 古典自由主義、理性、重證據\n' +
    '- 對情緒化、感性的主流論述持反向角度\n' +
    '- 繁體中文、粵語口語化\n' +
    '- 節奏緊湊、零廢話、無填充、無重複、無套話\n\n' +
    '【節目格式】\n' +
    `- 軌道：${trackLabel}\n` +
    `- 目標時長：${duration_min} 分鐘（約 ${minChars}–${maxChars} 繁體中文字）\n` +
    `- ${ctaGuidance}\n\n` +
    '【輸入】\n' +
    `主題：${subject}\n\n` +
    `立論：${thesis}\n\n` +
    '關鍵事實（第四節展開）：\n' +
    keyFactsBlock +
    '\n\n反向證據（第五節事實性承認與整合）：\n' +
    counterBlock +
    (collapseBlock ? '\n\n' + collapseBlock : '') +
    '\n\n【結構（必須遵守，共六節）】\n' +
    '## 一、鉤子（1–2 分鐘）\n' +
    '冷開場。不要自我介紹、不要「大家好」、不要「今日講」。直接用具體觀察、數據或場景切入，立即抓住注意。\n\n' +
    '## 二、為何這事對你重要 + 為何這個角度與眾不同（2–3 分鐘）\n' +
    '把「為你重要」和「我這個看法與眾不同」鎖在一起——這是每集都內建的預告邏輯，不是事後補上的「後面還有」。\n\n' +
    '## 三、脈絡（3–5 分鐘）\n' +
    '把主題放在更大的歷史、經濟或政治脈絡裡，為受眾建立必要背景。\n\n' +
    '## 四、三個關鍵事實與支持證據（15–18 分鐘）\n' +
    '依次展開三個最重要的事實面向。每個事實都必須附具體證據、數據或來源（用上方提供的關鍵事實清單）。這是整集主體。\n\n' +
    '## 五、反向證據的承認與整合（3–5 分鐘）\n' +
    '以事實面對反向證據，不逃避。承認「這些數據/研究指向另一個方向」，然後解釋為何即便如此立論仍然成立（或需要如何修正邊界條件）。絕不是修辭式反駁。\n\n' +
    '## 六、結語 + CTA（1–2 分鐘）\n' +
    '一句話總結立論，然後進入軌道對應的 CTA。\n\n' +
    '【輸出要求】\n' +
    '1. 只輸出腳本本體，不要任何前言（「以下是腳本」）、後記（「希望這個版本」）、或 Markdown 圍欄。\n' +
    '2. 第一行是 `# <主題>`（一級標題）。六節各用 `## 一、鉤子（1–2 分鐘）` 格式的二級標題。\n' +
    '3. 每節之下是連貫的粵語口語散文，不是 bullet points 、不是 outline。\n' +
    `4. 目標總字數 ${minChars}–${maxChars} 字。寧可少一些也不要填充。\n` +
    '5. 引用事實時直接把事實融入敘述；不要貼 URL 或來源名稱入文，除非自然（例如「彭博上個月報導」）。\n'
  );
}

async function callSonnet(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for generate_script');
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
        max_tokens: MAX_TOKENS,
        temperature: 0.65,
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
  return {
    text,
    usage: data?.usage || null,
    model,
    stop_reason: data?.stop_reason || null
  };
}

function estimateCharCount(text) {
  // Strip Markdown syntax for a closer approximation of spoken character count.
  const stripped = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>\[\]\(\)]/g, '')
    .replace(/\s+/g, '');
  return stripped.length;
}

export function registerGenerateScript(server) {
  server.registerTool(
    'generate_script',
    {
      title: 'Generate script',
      description:
        'Generates a 30-minute (configurable) Traditional Chinese full-prose script for the requested track. Follows the six-section structure verbatim: hook / why-this-matters+differentiation / context / three key facts / counter-evidence integration / close+track-CTA. YouTube ends with a members-conversion preview; podcast ends with a curiosity hook for the next members episode. Counter-evidence is acknowledged factually, never rhetorically. Output is plain Markdown (H1 subject + H2 section headers + prose, no bullets). Typically called after build_thesis_brief — pass thesis + supporting_evidence + counter_evidence + collapses_if straight through. Requires ANTHROPIC_API_KEY; STUDIO_SONNET_MODEL env var overrides the default claude-sonnet-4-5.',
      inputSchema: InputSchema
    },
    async ({
      subject,
      thesis,
      key_facts,
      counter_evidence,
      collapses_if,
      track,
      duration_min
    }) => {
      const prompt = buildPrompt({
        subject,
        thesis,
        key_facts,
        counter_evidence,
        collapses_if,
        track,
        duration_min
      });
      const sonnet = await callSonnet(prompt);
      const script = sonnet.text.trim();
      const charCount = estimateCharCount(script);
      const minChars = Math.round(duration_min * 150);
      const maxChars = Math.round(duration_min * 200);
      const payload = {
        subject,
        track,
        duration_min_target: duration_min,
        char_count: charCount,
        char_count_target: [minChars, maxChars],
        on_target: charCount >= minChars && charCount <= maxChars,
        sonnet_model: sonnet.model,
        stop_reason: sonnet.stop_reason,
        usage: sonnet.usage,
        script
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      };
    }
  );
}
