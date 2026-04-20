import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

// Daily GDELT signal aggregator. For every active gdelt lane in the
// sources table, queries the DOC 2.0 Timeline API three ways (tone,
// source-country, language) over the trailing 24h, then merges into
// one row per (day, lane) in gdelt_signal. Feeds the briefing prompt's
// "Signals" preamble (wired in a separate PR).
//
// Fires at 07:30 America/New_York so data is fresh when the morning
// briefing runs at 08:00. Volume: 4 lanes × 3 HTTP calls = 12 requests
// per day. Well inside GDELT's rate budget.
//
// Themes (top_themes) are left as an empty JSONB array in v1 — the DOC
// Timeline API doesn't return theme breakdowns, and the lighter-weight
// alternatives (WordCloudImageThemes) need separate plumbing. Defer to
// phase C if the briefing prompt actually wants theme-level signal.

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 07:30 ET',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '30 7 * * *' }] },
      timezone: 'America/New_York'
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

// Shared GDELT Timeline HTTP node factory — only the mode differs.
function timelineNode(name: string, mode: string, x: number) {
  return node({
    type: 'n8n-nodes-base.httpRequest',
    version: 4.4,
    config: {
      name: name,
      parameters: {
        method: 'GET',
        url: 'https://api.gdeltproject.org/api/v2/doc/doc',
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'query',    value: expr("={{ $('Fetch GDELT Lanes').item.json.config.query }}") },
            { name: 'mode',     value: mode },
            { name: 'format',   value: 'json' },
            { name: 'timespan', value: '24h' },
            { name: 'sort',     value: 'datedesc' }
          ]
        },
        options: {
          response: { response: { responseFormat: 'json' } },
          timeout: 45000
        }
      },
      onError: 'continueRegularOutput',
      position: [x, 300]
    },
    output: [{ timeline: [{ series: 'Sample', data: [{ date: '20260420T000000Z', value: 0, count: 0 }] }] }]
  });
}

const callTone          = timelineNode('GDELT TimelineTone',          'TimelineTone',          720);
const callSourceCountry = timelineNode('GDELT TimelineSourceCountry', 'TimelineSourceCountry', 960);
const callLang          = timelineNode('GDELT TimelineLang',          'TimelineLang',          1200);

const merge = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Lane Signals',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        "// ET date (YYYY-MM-DD) for the signal row's day column.",
        "function etDate() {",
        "  const parts = new Intl.DateTimeFormat('en-CA', {",
        "    timeZone: 'America/New_York',",
        "    year: 'numeric', month: '2-digit', day: '2-digit'",
        "  }).formatToParts(new Date());",
        "  const y  = parts.find(function(p) { return p.type === 'year';  }).value;",
        "  const mo = parts.find(function(p) { return p.type === 'month'; }).value;",
        "  const d  = parts.find(function(p) { return p.type === 'day';   }).value;",
        "  return y + '-' + mo + '-' + d;",
        "}",
        "",
        "// TimelineTone: one series with per-bin { value, count }.",
        "// Weighted avg tone = sum(value * count) / sum(count). Also gives total articles.",
        "function parseTone(resp) {",
        "  const tl = (resp && resp.timeline) || [];",
        "  if (!tl.length) return { articles: 0, avg_tone: null };",
        "  const data = tl[0].data || [];",
        "  let totalN = 0; let weighted = 0;",
        "  for (let i = 0; i < data.length; i++) {",
        "    const n = Number(data[i].count) || 0;",
        "    const v = Number(data[i].value) || 0;",
        "    totalN += n;",
        "    weighted += v * n;",
        "  }",
        "  return { articles: totalN, avg_tone: totalN > 0 ? Number((weighted / totalN).toFixed(2)) : null };",
        "}",
        "",
        "// Timeline breakdowns (SourceCountry, Lang): one series per dimension; value per bin",
        "// is volume. Sum per series, rank descending, return top N as [{name, n}].",
        "function parseBreakdown(resp, topN) {",
        "  const tl = (resp && resp.timeline) || [];",
        "  const totals = [];",
        "  for (let s = 0; s < tl.length; s++) {",
        "    const name = tl[s].series || '(unknown)';",
        "    const data = tl[s].data || [];",
        "    let total = 0;",
        "    for (let i = 0; i < data.length; i++) total += Number(data[i].value) || 0;",
        "    if (total > 0) totals.push({ name: name, n: Number(total.toFixed(2)) });",
        "  }",
        "  totals.sort(function(a, b) { return b.n - a.n; });",
        "  return totals.slice(0, topN);",
        "}",
        "",
        "const day = etDate();",
        "const lanes = $('Fetch GDELT Lanes').all();",
        "const tones = $('GDELT TimelineTone').all();",
        "const countries = $('GDELT TimelineSourceCountry').all();",
        "const langs = $('GDELT TimelineLang').all();",
        "",
        "const out = [];",
        "for (let k = 0; k < lanes.length; k++) {",
        "  const src = (lanes[k] && lanes[k].json) || {};",
        "  const subtype = (src.config && src.config.subtype) || 'unknown';",
        "  const toneResp        = (tones[k]     && tones[k].json)     || {};",
        "  const countryResp     = (countries[k] && countries[k].json) || {};",
        "  const langResp        = (langs[k]     && langs[k].json)     || {};",
        "  const toneAgg = parseTone(toneResp);",
        "  const topCountries = parseBreakdown(countryResp, 5);",
        "  const topLangs     = parseBreakdown(langResp, 5);",
        "  out.push({",
        "    json: {",
        "      day: day,",
        "      lane: subtype,",
        "      articles: toneAgg.articles,",
        "      avg_tone: toneAgg.avg_tone,",
        "      top_source_countries: JSON.stringify(topCountries),",
        "      top_langs:            JSON.stringify(topLangs),",
        "      top_themes:           '[]'",
        "    },",
        "    pairedItem: { item: k }",
        "  });",
        "}",
        "return out;"
      ].join('\n')
    },
    position: [1440, 300]
  },
  output: [{ day: '2026-04-20', lane: 'hk-core', articles: 342, avg_tone: -2.15, top_source_countries: '[{"name":"United States","n":120}]', top_langs: '[{"name":"English","n":280}]', top_themes: '[]' }]
});

const upsert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert GDELT Signal',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO gdelt_signal (day, lane, articles, avg_tone, top_source_countries, top_langs, top_themes, fetched_at) VALUES ($1::date, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, NOW()) ON CONFLICT (day, lane) DO UPDATE SET articles = EXCLUDED.articles, avg_tone = EXCLUDED.avg_tone, top_source_countries = EXCLUDED.top_source_countries, top_langs = EXCLUDED.top_langs, top_themes = EXCLUDED.top_themes, fetched_at = NOW()",
      options: {
        queryReplacement: expr('={{ [$json.day, $json.lane, $json.articles, $json.avg_tone, $json.top_source_countries, $json.top_langs, $json.top_themes] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1680, 300]
  },
  output: [{}]
});

export default workflow('fetch-gdelt-signal-daily', 'Fetch GDELT Signal Daily')
  .add(schedule)
  .to(fetchLanes)
  .to(callTone)
  .to(callSourceCountry)
  .to(callLang)
  .to(merge)
  .to(upsert);
