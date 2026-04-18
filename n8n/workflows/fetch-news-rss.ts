import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 6 hours',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 */6 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchSources = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch RSS Sources',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT id, name, language, tags, config FROM sources WHERE type = 'rss' AND enabled = TRUE ORDER BY name"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [
    { id: 1, name: 'RTHK 本地新聞', language: 'zh-TW', tags: ['hongkong'], config: { url: 'https://rthk.hk/rthk/news/rss/c_expressnews_clocal.xml' } }
  ]
});

const readRss = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: {
    name: 'Read RSS Feed',
    parameters: {
      url: expr('{{ $json.config.url }}'),
      options: { ignoreSSL: false }
    },
    onError: 'continueRegularOutput',
    position: [720, 300]
  },
  output: [
    { title: 'Sample headline', link: 'https://example.com/article', contentSnippet: 'Sample excerpt', isoDate: '2026-04-18T12:00:00Z' }
  ]
});

const normalize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Item',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: [
        "const crypto = require('crypto');",
        "const item = $json;",
        "const src = $('Fetch RSS Sources').item.json;",
        "",
        "const url = (item.link || item.guid || '').trim();",
        "if (!url) { return { json: {} }; }",
        "",
        "const article_id = crypto.createHash('sha1').update(url).digest('hex').substring(0, 16);",
        "const headline = (item.title || '').trim();",
        "if (!headline) { return { json: {} }; }",
        "",
        "let excerpt = item.contentSnippet || item.summary || item.content || '';",
        "if (typeof excerpt === 'object') excerpt = '';",
        "excerpt = String(excerpt).replace(/<[^>]+>/g, '').trim().substring(0, 500);",
        "",
        "const published_at = item.isoDate || item.pubDate || null;",
        "",
        "const tagsArr = Array.isArray(src.tags) ? src.tags : [];",
        "const tagsLiteral = '{' + tagsArr.map(function(t) {",
        "  return '\"' + String(t) + '\"';",
        "}).join(',') + '}';",
        "",
        "return {",
        "  json: {",
        "    article_id: article_id,",
        "    source_name: src.name,",
        "    source_type: 'rss',",
        "    url: url,",
        "    headline: headline,",
        "    excerpt: excerpt || null,",
        "    language: src.language,",
        "    tags_literal: tagsLiteral,",
        "    published_at: published_at",
        "  }",
        "};"
      ].join('\n'),
    },
    position: [960, 300]
  },
  output: [{ article_id: '1234567890abcdef', source_name: 'RTHK', source_type: 'rss', url: 'https://example.com', headline: 'Sample', excerpt: 'excerpt', language: 'zh-TW', tags_literal: '{"hongkong"}', published_at: '2026-04-18T12:00:00Z' }]
});

const saveItem = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save News Item',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO news_items (article_id, source_name, source_type, url, headline, excerpt, language, tags, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::timestamptz) ON CONFLICT (article_id) DO NOTHING",
      options: {
        queryReplacement: expr('{{ [$json.article_id, $json.source_name, $json.source_type, $json.url, $json.headline, $json.excerpt, $json.language, $json.tags_literal, $json.published_at] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1200, 300]
  },
  output: [{}]
});

export default workflow('fetch-news-rss', 'Fetch News (RSS)')
  .add(schedule)
  .to(fetchSources)
  .to(readRss)
  .to(normalize)
  .to(saveItem);
