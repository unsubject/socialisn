import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 6 Hours',
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: '0 4,10,16,22 * * *' }] }
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchChannels = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch YouTube Channels',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT id, name, language, tags, config FROM sources WHERE type = 'youtube' AND enabled = TRUE ORDER BY name"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [{ id: 1, name: '城寨', language: 'zh', tags: ['canada','hongkong'], config: { channel_id: 'UC0zUmHNpkviI6UZ0uqCYrww' } }]
});

const derivePlaylistIds = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Derive Playlist IDs',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "var src = $json;\nvar channelId = src.config && src.config.channel_id;\nif (!channelId) return { json: { skip: true } };\nvar playlistId = 'UU' + channelId.substring(2);\nvar cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();\nreturn {\n  json: {\n    channel_id: channelId,\n    channel_name: src.name,\n    channel_language: src.language || 'zh',\n    channel_tags: src.tags || [],\n    playlist_id: playlistId,\n    published_after: cutoff\n  }\n};"
    },
    position: [720, 300]
  },
  output: [{ channel_id: 'UC0zUmHNpkviI6UZ0uqCYrww', channel_name: '城寨', channel_language: 'zh', channel_tags: ['canada','hongkong'], playlist_id: 'UU0zUmHNpkviI6UZ0uqCYrww', published_after: '2026-04-17T04:00:00.000Z' }]
});

const fetchPlaylistItems = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Playlist Items',
    parameters: {
      method: 'GET',
      url: 'https://www.googleapis.com/youtube/v3/playlistItems',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpQueryAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'playlistId', value: expr('={{ $json.playlist_id }}') },
          { name: 'part', value: 'contentDetails' },
          { name: 'maxResults', value: '50' }
        ]
      },
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 500 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 15000
      }
    },
    credentials: { httpQueryAuth: newCredential('YouTube API Key') },
    onError: 'continueRegularOutput',
    position: [960, 300]
  },
  output: [{ items: [{ contentDetails: { videoId: 'abc123', videoPublishedAt: '2026-04-18T10:00:00Z' } }], pageInfo: { totalResults: 1 } }]
});

const filterRecentVideos = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Filter Recent Videos',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "var inputs = $input.all();\nvar chItems = $(\"Derive Playlist IDs\").all();\nvar results = [];\nfor (var k = 0; k < inputs.length; k++) {\n  var resp = inputs[k].json || {};\n  var ch = (chItems[k] && chItems[k].json) || {};\n  if (!ch || ch.skip || !resp.items || !Array.isArray(resp.items)) continue;\n  var cutoff = ch.published_after;\n  for (var i = 0; i < resp.items.length; i++) {\n    var details = resp.items[i].contentDetails || {};\n    var videoId = details.videoId;\n    var publishedAt = details.videoPublishedAt || '';\n    if (!videoId) continue;\n    if (publishedAt && publishedAt < cutoff) continue;\n    results.push({ json: { video_id: videoId, channel_id: ch.channel_id, channel_name: ch.channel_name, channel_language: ch.channel_language, channel_tags: ch.channel_tags }, pairedItem: { item: k } });\n  }\n}\nreturn results;"
    },
    position: [1200, 300]
  },
  output: [{ video_id: 'abc123', channel_id: 'UC0zUmHNpkviI6UZ0uqCYrww', channel_name: '城寨', channel_language: 'zh', channel_tags: ['canada','hongkong'] }]
});

const fetchVideoDetails = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Video Details',
    parameters: {
      method: 'GET',
      url: 'https://www.googleapis.com/youtube/v3/videos',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpQueryAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'id', value: expr('={{ $json.video_id }}') },
          { name: 'part', value: 'snippet,contentDetails,statistics' }
        ]
      },
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 300 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 15000
      }
    },
    credentials: { httpQueryAuth: newCredential('YouTube API Key') },
    onError: 'continueRegularOutput',
    position: [1440, 300]
  },
  output: [{ items: [{ id: 'abc123', snippet: { title: 'Video Title', description: 'desc', publishedAt: '2026-04-18T10:00:00Z', channelId: 'UC0zUmHNpkviI6UZ0uqCYrww', tags: ['news'], thumbnails: { high: { url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg' } } }, contentDetails: { duration: 'PT1H2M3S' }, statistics: { viewCount: '1000', likeCount: '50', commentCount: '10' } }] }]
});

const buildVideoRecord = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Video Record',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "var response = $json;\nvar src = $(\"Filter Recent Videos\").item.json;\nif (!src || src.skip) return { json: { skip: true } };\nvar items = response.items;\nif (!Array.isArray(items) || items.length === 0) return { json: { skip: true } };\nvar video = items[0];\nvar snippet = video.snippet || {};\nvar details = video.contentDetails || {};\nvar stats = video.statistics || {};\nfunction parseDuration(iso) {\n  var m = String(iso || '').match(/PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?/);\n  if (!m) return 0;\n  return (parseInt(m[1] || '0') * 3600) + (parseInt(m[2] || '0') * 60) + parseInt(m[3] || '0');\n}\nvar channelTags = Array.isArray(src.channel_tags) ? src.channel_tags : [];\nvar channelTagsLiteral = '{' + channelTags.map(function(t) { return '\"' + String(t) + '\"'; }).join(',') + '}';\nvar videoTags = Array.isArray(snippet.tags) ? snippet.tags : [];\nvar tagsLiteral = '{' + videoTags.map(function(t) { return '\"' + String(t).replace(/\"/g, '') + '\"'; }).join(',') + '}';\nreturn {\n  json: {\n    video_id: video.id,\n    channel_id: src.channel_id,\n    channel_name: src.channel_name,\n    channel_tags_literal: channelTagsLiteral,\n    title: snippet.title || '',\n    description: (snippet.description || '').substring(0, 5000),\n    published_at: snippet.publishedAt || null,\n    duration_seconds: parseDuration(details.duration),\n    view_count: parseInt(stats.viewCount || '0'),\n    like_count: parseInt(stats.likeCount || '0'),\n    comment_count: parseInt(stats.commentCount || '0'),\n    thumbnail_url: (snippet.thumbnails && snippet.thumbnails.high && snippet.thumbnails.high.url) || '',\n    tags_literal: tagsLiteral\n  }\n};"
    },
    position: [1680, 300]
  },
  output: [{ video_id: 'abc123', channel_id: 'UC0zUmHNpkviI6UZ0uqCYrww', channel_name: '城寨', channel_tags_literal: '{"canada","hongkong"}', title: 'Video Title', description: 'desc', published_at: '2026-04-18T10:00:00Z', duration_seconds: 3723, view_count: 1000, like_count: 50, comment_count: 10, thumbnail_url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', tags_literal: '{"news"}' }]
});

const saveVideo = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save YouTube Video',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO youtube_items (video_id, channel_id, channel_name, channel_tags, title, description, published_at, duration_seconds, view_count, like_count, comment_count, thumbnail_url, tags, fetched_at) VALUES ($1, $2, $3, $4::text[], $5, $6, $7::timestamptz, $8::integer, $9::integer, $10::integer, $11::integer, $12, $13::text[], NOW()) ON CONFLICT (video_id) DO UPDATE SET view_count = EXCLUDED.view_count, like_count = EXCLUDED.like_count, comment_count = EXCLUDED.comment_count, fetched_at = NOW()",
      options: {
        queryReplacement: expr('={{ [$json.video_id, $json.channel_id, $json.channel_name, $json.channel_tags_literal, $json.title, $json.description, $json.published_at, $json.duration_seconds, $json.view_count, $json.like_count, $json.comment_count, $json.thumbnail_url, $json.tags_literal] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1920, 300]
  },
  output: [{}]
});

const triggerTranscripts = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Trigger Transcript Enrichment',
    parameters: {
      source: 'database',
      workflowId: 'VuYc4FsgAxoDNMu7',
      mode: 'once',
      options: {
        waitForSubWorkflow: false
      }
    },
    position: [2160, 300]
  },
  output: [{}]
});

export default workflow('fetch-youtube', 'Fetch YouTube Videos')
  .add(schedule)
  .to(fetchChannels)
  .to(derivePlaylistIds)
  .to(fetchPlaylistItems)
  .to(filterRecentVideos)
  .to(fetchVideoDetails)
  .to(buildVideoRecord)
  .to(saveVideo)
  .to(triggerTranscripts);
