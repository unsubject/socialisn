import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 6 hours',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 1,7,13,19 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchSources = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Podcast Sources',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT id, name, language, tags, config FROM sources WHERE type = 'podcast' AND enabled = TRUE ORDER BY name"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [{ id: 1, name: 'Unhedged', language: 'en', tags: ['finance','ft'], config: { apple_id: '1691284824' } }]
});

const itunesLookup = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'iTunes Lookup',
    parameters: {
      method: 'GET',
      url: expr('={{ "https://itunes.apple.com/lookup?id=" + $json.config.apple_id }}'),
      options: {
        response: { response: { responseFormat: 'json' } },
        timeout: 10000
      }
    },
    onError: 'continueRegularOutput',
    position: [720, 300]
  },
  output: [{ resultCount: 1, results: [{ feedUrl: 'https://feeds.example.com/podcast.xml' }] }]
});

const extractFeedUrl = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Feed URL',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: [
        "const itunes = $json;",
        "const src = $('Fetch Podcast Sources').item.json;",
        "const feedUrl = (itunes.results && itunes.results.length > 0)",
        "  ? itunes.results[0].feedUrl : null;",
        "if (!feedUrl) return { json: { skip: true } };",
        "return {",
        "  json: {",
        "    feed_url: feedUrl,",
        "    source_name: src.name,",
        "    source_language: src.language,",
        "    source_tags: src.tags,",
        "    apple_id: src.config ? src.config.apple_id : ''",
        "  }",
        "};"
      ].join('\n'),
    },
    position: [960, 300]
  },
  output: [{ feed_url: 'https://feeds.example.com/pod.xml', source_name: 'Unhedged', source_language: 'en', source_tags: ['finance'], apple_id: '1691284824' }]
});

const readRss = node({
  type: 'n8n-nodes-base.rssFeedRead',
  version: 1.2,
  config: {
    name: 'Read Podcast Feed',
    parameters: {
      url: expr('{{ $json.feed_url }}'),
      options: { ignoreSSL: false }
    },
    onError: 'continueRegularOutput',
    position: [1200, 300]
  },
  output: [{ title: 'Episode Title', link: 'https://example.com/ep1', contentSnippet: 'Description', isoDate: '2026-04-18T12:00:00Z', guid: 'ep-guid-123' }]
});

const normalize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Episode',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: [
        "const crypto = require('crypto');",
        "const item = $json;",
        "const src = $('Extract Feed URL').item.json;",
        "",
        "const guid = item.guid || item.link || item.id || '';",
        "if (!guid) return { json: {} };",
        "",
        "const episode_id = crypto.createHash('sha1').update(guid).digest('hex').substring(0, 16);",
        "const title = (item.title || '').trim();",
        "if (!title) return { json: {} };",
        "",
        "let duration_seconds = null;",
        "const durStr = item['itunes:duration'] || item.itunes_duration || '';",
        "if (durStr) {",
        "  const parts = String(durStr).split(':');",
        "  if (parts.length === 3) duration_seconds = parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseInt(parts[2]);",
        "  else if (parts.length === 2) duration_seconds = parseInt(parts[0])*60 + parseInt(parts[1]);",
        "  else duration_seconds = parseInt(parts[0]) || null;",
        "}",
        "",
        "const tagsArr = Array.isArray(src.source_tags) ? src.source_tags : [];",
        "const tagsLiteral = '{' + tagsArr.map(function(t) {",
        "  return '\"' + String(t) + '\"';",
        "}).join(',') + '}';",
        "",
        "let desc = item.contentSnippet || item.summary || item.content || '';",
        "if (typeof desc === 'object') desc = '';",
        "desc = String(desc).replace(/<[^>]+>/g, '').trim().substring(0, 1000);",
        "",
        "return {",
        "  json: {",
        "    episode_id: episode_id,",
        "    podcast_name: src.source_name,",
        "    podcast_tags_literal: tagsLiteral,",
        "    title: title,",
        "    description: desc || null,",
        "    episode_url: item.link || '',",
        "    duration_seconds: duration_seconds,",
        "    published_at: item.isoDate || item.pubDate || null",
        "  }",
        "};"
      ].join('\n'),
    },
    position: [1440, 300]
  },
  output: [{ episode_id: 'abc123', podcast_name: 'Unhedged', podcast_tags_literal: '{"finance","ft"}', title: 'Episode', description: 'desc', episode_url: 'https://example.com/ep', duration_seconds: 1800, published_at: '2026-04-18T12:00:00Z' }]
});

const saveEpisode = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Podcast Episode',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO podcast_items (episode_id, podcast_name, podcast_tags, title, description, episode_url, duration_seconds, published_at) VALUES ($1, $2, $3::text[], $4, $5, $6, $7::integer, $8::timestamptz) ON CONFLICT (episode_id) DO NOTHING",
      options: {
        queryReplacement: expr('{{ [$json.episode_id, $json.podcast_name, $json.podcast_tags_literal, $json.title, $json.description, $json.episode_url, $json.duration_seconds, $json.published_at] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1680, 300]
  },
  output: [{}]
});

export default workflow('fetch-podcasts', 'Fetch Podcasts')
  .add(schedule)
  .to(fetchSources)
  .to(itunesLookup)
  .to(extractFeedUrl)
  .to(readRss)
  .to(normalize)
  .to(saveEpisode);
