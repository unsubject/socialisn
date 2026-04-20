import { z } from 'zod';
import { pool } from '../db.js';
import { escapeLikeLiteral } from '../lib/scoring.js';

const ALL_SOURCES = ['newsletter', 'news', 'youtube', 'podcast'];

const InputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Text to match ILIKE against each source\'s primary field plus the joined Traditional Chinese summary + keywords from item_enrichment.'
    ),
  window_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(72)
    .describe('Look-back window in hours. Default 72 (3 days). Max 720 (30 days).'),
  sources: z
    .array(z.enum(ALL_SOURCES))
    .optional()
    .describe(
      'Restrict to specific source types ("newsletter", "news", "youtube", "podcast"). Omit to search all four.'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(30)
    .describe('Maximum hits to return, ordered by most-recent fetched_at.')
};

const SEARCH_SQL = `
WITH hits AS (
  SELECT 'newsletter'::text AS source_type,
         nl.message_id      AS id,
         nl.subject         AS title,
         nl.sender_name     AS source_name,
         NULL::text         AS url,
         nl.fetched_at,
         nl.received_at     AS published_at,
         e.summary_zh,
         e.keywords_zh
    FROM newsletter_items nl
    LEFT JOIN item_enrichment e
      ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
   WHERE 'newsletter' = ANY($3::text[])
     AND nl.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       nl.subject ILIKE $2
       OR COALESCE(nl.summary, '') ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'news'::text,
         n.article_id,
         n.headline,
         n.source_name,
         n.url,
         n.fetched_at,
         n.published_at,
         e.summary_zh,
         e.keywords_zh
    FROM news_items n
    LEFT JOIN item_enrichment e
      ON e.item_type = 'news' AND e.item_id = n.article_id
   WHERE 'news' = ANY($3::text[])
     AND n.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       n.headline ILIKE $2
       OR COALESCE(n.excerpt, '') ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'youtube'::text,
         y.video_id,
         y.title,
         y.channel_name,
         'https://www.youtube.com/watch?v=' || y.video_id,
         y.fetched_at,
         y.published_at,
         e.summary_zh,
         e.keywords_zh
    FROM youtube_items y
    LEFT JOIN item_enrichment e
      ON e.item_type = 'youtube' AND e.item_id = y.video_id
   WHERE 'youtube' = ANY($3::text[])
     AND y.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       y.title ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'podcast'::text,
         p.episode_id,
         p.title,
         p.podcast_name,
         p.episode_url,
         p.fetched_at,
         p.published_at,
         e.summary_zh,
         e.keywords_zh
    FROM podcast_items p
    LEFT JOIN item_enrichment e
      ON e.item_type = 'podcast' AND e.item_id = p.episode_id
   WHERE 'podcast' = ANY($3::text[])
     AND p.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       p.title ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
)
SELECT source_type, id, title, source_name, url, fetched_at, published_at,
       summary_zh, keywords_zh
  FROM hits
 ORDER BY fetched_at DESC
 LIMIT $4
`;

function toIso(v) {
  return v instanceof Date ? v.toISOString() : v;
}

export function registerSearchDiscourse(server) {
  server.registerTool(
    'search_discourse',
    {
      title: 'Search discourse',
      description:
        'Ad-hoc RAG over the socialisn corpus: newsletters, news (including Perplexity summaries stored with source_type="perplexity"), YouTube, and podcasts. Matches ILIKE against each source\'s primary text plus its Traditional Chinese summary and keywords from item_enrichment. Returns the most-recent hits.',
      inputSchema: InputSchema
    },
    async ({ query, window_hours, sources, limit }) => {
      const effectiveSources = sources && sources.length ? sources : ALL_SOURCES;
      const pattern = `%${escapeLikeLiteral(query)}%`;
      const { rows } = await pool.query(SEARCH_SQL, [
        window_hours,
        pattern,
        effectiveSources,
        limit
      ]);
      const hits = rows.map((r) => ({
        source_type: r.source_type,
        id: r.id,
        title: r.title,
        source_name: r.source_name,
        url: r.url,
        summary_zh: r.summary_zh,
        keywords_zh: r.keywords_zh,
        fetched_at: toIso(r.fetched_at),
        published_at: toIso(r.published_at)
      }));
      const payload = {
        query,
        window_hours,
        sources: effectiveSources,
        count: hits.length,
        hits
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      };
    }
  );
}
