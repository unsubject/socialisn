import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

// Hourly GDELT DOC 2.0 ArtList fetcher, fan-out across N lanes defined in
// the sources table. Each lane writes into news_items with source_type='gdelt'
// and source_subtype=<lane slug> so briefings and the signal workflow can
// filter by lane. GDELT is unauthenticated — no credential binding needed
// for the HTTP node. Rate is 3 requests per hour for the current 3-lane
// config, well inside GDELT's "be reasonable" budget (~1 rps sustained).

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Hourly :15',
    parameters: {
      // Offset 15m from the Gmail :00 fetch to avoid cron collisions.
      rule: { interval: [{ field: 'cronExpression', expression: '15 * * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchLanes = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch GDELT Lanes',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT id, name, language, tags, config FROM sources WHERE type = 'gdelt' AND enabled = TRUE ORDER BY name"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [
    { id: 200, name: 'GDELT · HK Core', language: 'en', tags: ['hongkong','gdelt'], config: { subtype: 'hk-core', query: '("hong kong" OR 香港) (sourcelang:english OR sourcelang:chinese)' } }
  ]
});

const callGdelt = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GDELT DOC 2.0 ArtList',
    parameters: {
      method: 'GET',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'query',      value: expr('={{ $json.config.query }}') },
          { name: 'mode',       value: 'ArtList' },
          { name: 'format',     value: 'json' },
          { name: 'timespan',   value: '1h' },
          { name: 'maxrecords', value: '250' },
          { name: 'sort',       value: 'datedesc' }
        ]
      },
      options: {
        response: { response: { responseFormat: 'json' } },
        timeout: 30000
      }
    },
    onError: 'continueRegularOutput',
    position: [720, 300]
  },
  output: [{ articles: [{ url: 'https://example.com/a', title: 'Sample', seendate: '20260420T120000Z', domain: 'example.com', language: 'English', sourcecountry: 'United States' }] }]
});

const fanOut = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fan Out Articles',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        "// FNV-1a 64-bit hash → deterministic article_id from URL.",
        "function fnv1a64(str) {",
        "  let h = 0xcbf29ce484222325n;",
        "  const prime = 0x100000001b3n;",
        "  const mask = 0xffffffffffffffffn;",
        "  for (let i = 0; i < str.length; i++) {",
        "    h ^= BigInt(str.charCodeAt(i));",
        "    h = (h * prime) & mask;",
        "  }",
        "  return h.toString(16).padStart(16, '0');",
        "}",
        "",
        "// GDELT exposes language as a word (e.g. 'English', 'Chinese'). Map",
        "// a handful to ISO-ish codes used elsewhere in news_items.language.",
        "const LANG_MAP = {",
        "  'English': 'en',",
        "  'Chinese': 'zh',",
        "  'ChineseT': 'zh-TW',",
        "  'Spanish': 'es',",
        "  'French': 'fr',",
        "  'German': 'de',",
        "  'Japanese': 'ja',",
        "  'Korean': 'ko',",
        "  'Russian': 'ru',",
        "  'Arabic': 'ar'",
        "};",
        "",
        "// GDELT seendate is YYYYMMDDTHHMMSSZ — rehydrate to ISO.",
        "function parseSeenDate(s) {",
        "  if (!s || s.length < 15) return null;",
        "  const y  = s.substring(0,4);",
        "  const mo = s.substring(4,6);",
        "  const d  = s.substring(6,8);",
        "  const h  = s.substring(9,11);",
        "  const mi = s.substring(11,13);",
        "  const se = s.substring(13,15);",
        "  return y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + se + 'Z';",
        "}",
        "",
        "const out = [];",
        "const responses = $input.all();",
        "const lanes = $('Fetch GDELT Lanes').all();",
        "",
        "for (let k = 0; k < responses.length; k++) {",
        "  const resp = responses[k].json || {};",
        "  const articles = Array.isArray(resp.articles) ? resp.articles : [];",
        "  // lane index aligns with HTTP call order (n8n preserves pairedItem).",
        "  const src = (lanes[k] && lanes[k].json) || {};",
        "  const subtype = (src.config && src.config.subtype) || 'unknown';",
        "  const tagsArr = Array.isArray(src.tags) ? src.tags.slice() : [];",
        "  if (subtype && tagsArr.indexOf('lane:' + subtype) < 0) tagsArr.push('lane:' + subtype);",
        "  const tagsLiteral = '{' + tagsArr.map(function(t) { return '\"' + String(t) + '\"'; }).join(',') + '}';",
        "",
        "  for (let i = 0; i < articles.length; i++) {",
        "    const a = articles[i] || {};",
        "    const url = (a.url || '').trim();",
        "    const headline = (a.title || '').trim();",
        "    if (!url || !headline) continue;",
        "    const article_id = fnv1a64(url);",
        "    const lang = LANG_MAP[a.language] || (a.language ? String(a.language).toLowerCase().substring(0,5) : (src.language || 'en'));",
        "    const published_at = parseSeenDate(a.seendate);",
        "    out.push({",
        "      json: {",
        "        article_id:     article_id,",
        "        source_name:    src.name || 'GDELT',",
        "        source_type:    'gdelt',",
        "        source_subtype: subtype,",
        "        url:            url,",
        "        headline:       headline,",
        "        excerpt:        null,",
        "        language:       lang,",
        "        tags_literal:   tagsLiteral,",
        "        published_at:   published_at",
        "      },",
        "      pairedItem: { item: k }",
        "    });",
        "  }",
        "}",
        "",
        "return out;"
      ].join('\n')
    },
    position: [960, 300]
  },
  output: [{ article_id: '1234567890abcdef', source_name: 'GDELT · HK Core', source_type: 'gdelt', source_subtype: 'hk-core', url: 'https://example.com/a', headline: 'Sample', excerpt: null, language: 'en', tags_literal: '{"hongkong","gdelt","lane:hk-core"}', published_at: '2026-04-20T12:00:00Z' }]
});

const saveItem = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save GDELT Article',
    parameters: {
      operation: 'executeQuery',
      // DO NOTHING: GDELT URLs are durable; if a URL appears in multiple
      // lanes the first-write lane wins on source_subtype. Accepted tradeoff
      // given cross-lane overlap is expected to be low; revisit if the briefing
      // starts missing cross-tagged articles.
      query: "INSERT INTO news_items (article_id, source_name, source_type, source_subtype, url, headline, excerpt, language, tags, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::timestamptz) ON CONFLICT (article_id) DO NOTHING",
      options: {
        queryReplacement: expr('={{ [$json.article_id, $json.source_name, $json.source_type, $json.source_subtype, $json.url, $json.headline, $json.excerpt, $json.language, $json.tags_literal, $json.published_at] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1200, 300]
  },
  output: [{}]
});

export default workflow('fetch-gdelt-articles', 'Fetch GDELT Articles')
  .add(schedule)
  .to(fetchLanes)
  .to(callGdelt)
  .to(fanOut)
  .to(saveItem);
