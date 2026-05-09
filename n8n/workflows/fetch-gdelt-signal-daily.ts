import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

// Daily GDELT signal aggregator. For every active gdelt lane in the
// sources table, queries the DOC 2.0 Timeline API four ways (tone,
// volume-raw, source-country, language) over the trailing 24h, then
// merges into one row per (day, lane) in gdelt_signal. Feeds the
// briefing prompt's "Signals" preamble.
//
// 2026-05-09: TimelineTone returns {date,value} buckets where value is
// the avg tone for that bucket — there is NO count field. The previous
// parseTone() summed data[i].count (always 0) and stored articles=0 +
// avg_tone=null for every row since 2026-04-21. Fix: derive article
// volume from a separate TimelineVolRaw call, and tone as an unweighted
// mean of value across buckets.

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
    credentials: { postgres: newCredential('Railway') },
    position: [480, 300]
  },
  output: [
    { id: 200, name: 'GDELT · HK Core', language: 'en', tags: ['hongkong','gdelt'], config: { subtype: 'hk-core', query: '("hong kong" OR 香港) (sourcelang:english OR sourcelang:chinese)' } }
  ]
});

const callTone = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GDELT TimelineTone',
    parameters: {
      method: 'GET',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'query',    value: expr("={{ $('Fetch GDELT Lanes').item.json.config.query }}") },
          { name: 'mode',     value: 'TimelineTone' },
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
    position: [720, 300]
  },
  output: [{ timeline: [{ series: 'Average Tone', data: [{ date: '20260420T000000Z', value: -2.1 }] }] }]
});

const callVolRaw = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GDELT TimelineVolRaw',
    parameters: {
      method: 'GET',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'query',    value: expr("={{ $('Fetch GDELT Lanes').item.json.config.query }}") },
          { name: 'mode',     value: 'TimelineVolRaw' },
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
    position: [960, 300]
  },
  output: [{ timeline: [{ series: 'Article Count', data: [{ date: '20260420T000000Z', value: 12 }] }] }]
});

const callSourceCountry = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GDELT TimelineSourceCountry',
    parameters: {
      method: 'GET',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'query',    value: expr("={{ $('Fetch GDELT Lanes').item.json.config.query }}") },
          { name: 'mode',     value: 'TimelineSourceCountry' },
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
    position: [1200, 300]
  },
  output: [{ timeline: [{ series: 'United States', data: [{ date: '20260420T000000Z', value: 30 }] }] }]
});

const callLang = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GDELT TimelineLang',
    parameters: {
      method: 'GET',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'query',    value: expr("={{ $('Fetch GDELT Lanes').item.json.config.query }}") },
          { name: 'mode',     value: 'TimelineLang' },
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
    position: [1440, 300]
  },
  output: [{ timeline: [{ series: 'English', data: [{ date: '20260420T000000Z', value: 80 }] }] }]
});

const mergeSignalsCode = `function etDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y  = parts.find(function(p) { return p.type === 'year';  }).value;
  const mo = parts.find(function(p) { return p.type === 'month'; }).value;
  const d  = parts.find(function(p) { return p.type === 'day';   }).value;
  return y + '-' + mo + '-' + d;
}

// TimelineTone buckets are {date,value} where value is the avg tone
// for that bucket. Take an unweighted mean across buckets.
function parseTone(resp) {
  const tl = (resp && resp.timeline) || [];
  if (!tl.length) return null;
  const data = tl[0].data || [];
  let sum = 0; let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i].value);
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n > 0 ? Number((sum / n).toFixed(2)) : null;
}

// TimelineVolRaw buckets are {date,value} where value is the matched
// article count. Sum across buckets = 24h matched volume.
function parseVolume(resp) {
  const tl = (resp && resp.timeline) || [];
  if (!tl.length) return 0;
  let series = tl[0];
  for (let s = 0; s < tl.length; s++) {
    const name = String(tl[s].series || '').toLowerCase();
    if (name.indexOf('article') >= 0 || name.indexOf('volume') >= 0) { series = tl[s]; break; }
  }
  const data = series.data || [];
  let total = 0;
  for (let i = 0; i < data.length; i++) {
    total += Number(data[i].value) || 0;
  }
  return Math.round(total);
}

function parseBreakdown(resp, topN) {
  const tl = (resp && resp.timeline) || [];
  const totals = [];
  for (let s = 0; s < tl.length; s++) {
    const name = tl[s].series || '(unknown)';
    const data = tl[s].data || [];
    let total = 0;
    for (let i = 0; i < data.length; i++) total += Number(data[i].value) || 0;
    if (total > 0) totals.push({ name: name, n: Number(total.toFixed(2)) });
  }
  totals.sort(function(a, b) { return b.n - a.n; });
  return totals.slice(0, topN);
}

const day = etDate();
const lanes = $('Fetch GDELT Lanes').all();
const tones = $('GDELT TimelineTone').all();
const volumes = $('GDELT TimelineVolRaw').all();
const countries = $('GDELT TimelineSourceCountry').all();
const langs = $('GDELT TimelineLang').all();

const out = [];
for (let k = 0; k < lanes.length; k++) {
  const src = (lanes[k] && lanes[k].json) || {};
  const subtype = (src.config && src.config.subtype) || 'unknown';
  const toneResp    = (tones[k]     && tones[k].json)     || {};
  const volResp     = (volumes[k]   && volumes[k].json)   || {};
  const countryResp = (countries[k] && countries[k].json) || {};
  const langResp    = (langs[k]     && langs[k].json)     || {};
  const articles     = parseVolume(volResp);
  const avg_tone     = parseTone(toneResp);
  const topCountries = parseBreakdown(countryResp, 5);
  const topLangs     = parseBreakdown(langResp, 5);
  out.push({
    json: {
      day: day,
      lane: subtype,
      articles: articles,
      avg_tone: avg_tone,
      top_source_countries: JSON.stringify(topCountries),
      top_langs:            JSON.stringify(topLangs),
      top_themes:           '[]'
    },
    pairedItem: { item: k }
  });
}
return out;`;

const mergeSignals = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Lane Signals',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: mergeSignalsCode
    },
    position: [1680, 300]
  },
  output: [{ day: '2026-05-09', lane: 'hk-core', articles: 342, avg_tone: -2.15, top_source_countries: '[{"name":"United States","n":120}]', top_langs: '[{"name":"English","n":280}]', top_themes: '[]' }]
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
    credentials: { postgres: newCredential('Railway') },
    onError: 'continueRegularOutput',
    position: [1920, 300]
  },
  output: [{}]
});

export default workflow('fetch-gdelt-signal-daily', 'Fetch GDELT Signal Daily')
  .add(schedule)
  .to(fetchLanes)
  .to(callTone)
  .to(callVolRaw)
  .to(callSourceCountry)
  .to(callLang)
  .to(mergeSignals)
  .to(upsert);
