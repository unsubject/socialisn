import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const calledByYoutubeFetch = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Called by YouTube Fetch',
    parameters: {
      inputSource: 'passthrough'
    },
    position: [240, 300]
  },
  output: [{}]
});

const fetchMissing = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Videos Missing Transcripts',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT yi.video_id, COALESCE(s.language, 'en') AS channel_language FROM youtube_items yi LEFT JOIN sources s ON s.type = 'youtube' AND s.config->>'channel_id' = yi.channel_id WHERE yi.transcript_text IS NULL AND (yi.transcript_source IS NULL OR yi.transcript_source != 'unavailable') AND yi.fetched_at >= NOW() - INTERVAL '72 hours' ORDER BY yi.fetched_at DESC LIMIT 50"
    },
    credentials: { postgres: newCredential('Postgres') },
    position: [480, 300]
  },
  output: [{ video_id: 'abc123', channel_language: 'zh' }]
});

const buildRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Transcript Request',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "var item = $json;\nvar defaults = ['zh-TW', 'zh-Hant', 'zh', 'en'];\nvar langPrefs = defaults.slice();\nif (item.channel_language && langPrefs.indexOf(item.channel_language) === -1) {\n  langPrefs.unshift(item.channel_language);\n}\nreturn { json: { video_id: item.video_id, lang_prefs: langPrefs } };"
    },
    position: [720, 300]
  },
  output: [{ video_id: 'abc123', lang_prefs: ['zh', 'zh-TW', 'zh-Hant', 'en'] }]
});

const callHelpers = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Transcript',
    parameters: {
      method: 'POST',
      url: 'https://socialisn-production.up.railway.app/youtube-transcript',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({ video_id: $json.video_id, lang_prefs: $json.lang_prefs }) }}'),
      options: {
        batching: { batch: { batchSize: 1, batchInterval: 1000 } },
        response: { response: { responseFormat: 'json' } },
        timeout: 60000
      }
    },
    onError: 'continueRegularOutput',
    position: [960, 300]
  },
  output: [{ available: true, language: 'zh-TW', source: 'auto', text: 'Full transcript text here' }]
});

const buildUpdate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Update Values',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "var response = $json;\nvar src = $(\"Build Transcript Request\").item.json;\nif (!src || !src.video_id) return { json: { skip: true, video_id: null } };\nif (!response || typeof response.available === 'undefined') {\n  return { json: { skip: true, video_id: null } };\n}\nvar text = response.available ? (response.text || null) : null;\nvar language = response.available ? (response.language || null) : null;\nvar source = response.available ? (response.source || null) : 'unavailable';\nreturn { json: { video_id: src.video_id, transcript_text: text, transcript_lang: language, transcript_source: source } };"
    },
    position: [1200, 300]
  },
  output: [{ video_id: 'abc123', transcript_text: 'Full transcript', transcript_lang: 'zh-TW', transcript_source: 'auto' }]
});

const updateRow = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Video Transcript',
    parameters: {
      operation: 'executeQuery',
      query: "UPDATE youtube_items SET transcript_text = $1, transcript_lang = $2, transcript_source = $3 WHERE video_id = $4",
      options: {
        queryReplacement: expr('={{ [$json.transcript_text, $json.transcript_lang, $json.transcript_source, $json.video_id] }}')
      }
    },
    credentials: { postgres: newCredential('Postgres') },
    onError: 'continueRegularOutput',
    position: [1440, 300]
  },
  output: [{}]
});

export default workflow('enrich-youtube-transcripts', 'Enrich YouTube Transcripts')
  .add(calledByYoutubeFetch)
  .to(fetchMissing)
  .to(buildRequest)
  .to(callHelpers)
  .to(buildUpdate)
  .to(updateRow);
