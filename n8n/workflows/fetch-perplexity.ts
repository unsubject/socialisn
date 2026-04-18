import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 6 hours',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '25 0,6,12,18 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchSources = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Perplexity Queries',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT id, name, language, tags, config FROM sources WHERE type = 'perplexity' AND enabled = TRUE ORDER BY name"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [{ id: 100, name: 'HK Economy & Finance (EN)', language: 'en', tags: ['hongkong','economics','finance'], config: { query: 'Hong Kong economy and financial market news today' } }]
});

const callPerplexity = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Perplexity Sonar Search',
    parameters: {
      method: 'POST',
      url: 'https://api.perplexity.ai/chat/completions',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({ model: "sonar", messages: [ { role: "system", content: "You are a news research assistant. Return ONLY the top news stories from the past 24 hours matching the query. For each story, provide: the headline, a 1-2 sentence summary, and the source name. Format each story as a numbered list. Be factual and concise." }, { role: "user", content: $json.config.query } ], search_recency_filter: "day", return_citations: true, web_search_options: { search_context_size: "medium" }, temperature: 0.1 }) }}'),
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 2000 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 30000
      }
    },
    credentials: { httpBearerAuth: newCredential('Perplexity API') },
    onError: 'continueRegularOutput',
    position: [720, 300]
  },
  output: [{ choices: [{ message: { content: '1. Hang Seng up 2%...\n2. HKMA holds rate...' } }], citations: ['https://example.com/a', 'https://example.com/b'], search_results: [{ url: 'https://example.com/a', title: 'Hang Seng rallies' }] }]
});

const normalize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build News Record',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "const response = $json;\nconst src = $('Fetch Perplexity Queries').item.json;\n\nconst content = (response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content) || '';\nconst trimmed = String(content).trim();\nif (!trimmed) return { json: { skip: true } };\n\nconst citations = Array.isArray(response.citations) ? response.citations : [];\n\nfunction fnv1a64(str) {\n  let h = 0xcbf29ce484222325n;\n  const prime = 0x100000001b3n;\n  const mask = 0xffffffffffffffffn;\n  for (let i = 0; i < str.length; i++) {\n    h ^= BigInt(str.charCodeAt(i));\n    h = (h * prime) & mask;\n  }\n  return h.toString(16).padStart(16, '0');\n}\n\nconst queryStr = (src.config && src.config.query) || src.name;\nconst today = new Date().toISOString().substring(0, 10);\nconst article_id = fnv1a64(queryStr + '|' + today);\n\nconst firstCitation = citations.find(function(c) { return typeof c === 'string' && c.startsWith('http'); });\nconst url = firstCitation || ('perplexity://' + src.id + '/' + today);\n\nconst tagsArr = Array.isArray(src.tags) ? src.tags : [];\nconst tagsLiteral = '{' + tagsArr.map(function(t) { return '\"' + String(t) + '\"'; }).join(',') + '}';\n\nconst sourceCount = citations.length;\nconst headline = 'Perplexity: ' + src.name + ' (' + sourceCount + ' source' + (sourceCount === 1 ? '' : 's') + ')';\n\nconst excerpt = trimmed.substring(0, 500);\nconst fullText = trimmed.substring(0, 8000);\n\nreturn {\n  json: {\n    article_id: article_id,\n    source_name: 'Perplexity Search',\n    source_type: 'perplexity',\n    url: url,\n    headline: headline,\n    excerpt: excerpt,\n    full_text: fullText,\n    language: src.language,\n    tags_literal: tagsLiteral,\n    published_at: new Date().toISOString()\n  }\n};",
    },
    position: [960, 300]
  },
  output: [{ article_id: 'abc1234567890def', source_name: 'Perplexity Search', source_type: 'perplexity', url: 'https://example.com/a', headline: 'Perplexity: HK Economy & Finance (5 sources)', excerpt: 'Summary text...', full_text: 'Full summary...', language: 'en', tags_literal: '{"hongkong","economics","finance"}', published_at: '2026-04-18T12:00:00Z' }]
});

const saveItem = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Perplexity Summary',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO news_items (article_id, source_name, source_type, url, headline, excerpt, full_text, language, tags, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::timestamptz) ON CONFLICT (article_id) DO UPDATE SET excerpt = EXCLUDED.excerpt, full_text = EXCLUDED.full_text, fetched_at = NOW()",
      options: {
        queryReplacement: expr('={{ [$json.article_id, $json.source_name, $json.source_type, $json.url, $json.headline, $json.excerpt, $json.full_text, $json.language, $json.tags_literal, $json.published_at] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1200, 300]
  },
  output: [{}]
});

export default workflow('fetch-perplexity', 'Fetch Perplexity Search')
  .add(schedule)
  .to(fetchSources)
  .to(callPerplexity)
  .to(normalize)
  .to(saveItem);
