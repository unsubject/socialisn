import { z } from 'zod';
import { pool } from '../db.js';

const InputSchema = {
  topic: z
    .string()
    .min(1)
    .describe('Topic or keyword to score cross-source momentum for.'),
  window_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(72)
    .describe('Look-back window in hours. Default 72 (3 days). Max 720 (30 days).')
};

const MOMENTUM_SQL = `
WITH hits AS (
  SELECT 'newsletter'::text AS source_type, nl.sender_name AS source_name
    FROM newsletter_items nl
    LEFT JOIN item_enrichment e
      ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
   WHERE nl.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       nl.subject ILIKE $2
       OR COALESCE(nl.summary, '') ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'news'::text, n.source_name
    FROM news_items n
    LEFT JOIN item_enrichment e
      ON e.item_type = 'news' AND e.item_id = n.article_id
   WHERE n.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       n.headline ILIKE $2
       OR COALESCE(n.excerpt, '') ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'youtube'::text, y.channel_name
    FROM youtube_items y
    LEFT JOIN item_enrichment e
      ON e.item_type = 'youtube' AND e.item_id = y.video_id
   WHERE y.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       y.title ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
  UNION ALL
  SELECT 'podcast'::text, p.podcast_name
    FROM podcast_items p
    LEFT JOIN item_enrichment e
      ON e.item_type = 'podcast' AND e.item_id = p.episode_id
   WHERE p.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND (
       p.title ILIKE $2
       OR COALESCE(e.summary_zh, '') ILIKE $2
       OR COALESCE(ARRAY_TO_STRING(e.keywords_zh, ' '), '') ILIKE $2
     )
)
SELECT
  COUNT(*)::int AS distinct_mentions,
  COUNT(DISTINCT (source_type, source_name))::int AS distinct_sources
FROM hits
`;

function escapeLikeLiteral(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

// Log-shaped penalty that reaches 1.0 near ~20 mentions.
// Encodes the spec's "everyone is talking about it lowers the score" rule.
function saturationPenalty(mentions) {
  if (mentions <= 0) return 0;
  return Math.min(1, Math.log1p(mentions) / Math.log(20));
}

export function registerMomentum(server) {
  server.registerTool(
    'get_cross_source_momentum',
    {
      title: 'Cross-source momentum',
      description:
        'Raw momentum primitive. Counts distinct mentioning items and distinct (source_type, source_name) pairs for a topic across newsletter, news, YouTube, and podcast within the window, then computes velocity per day and a saturation penalty. Score = distinct_sources × distinct_mentions × velocity_per_day × (1 − saturation_penalty). High saturation is a signal to back away, not to pile on.',
      inputSchema: InputSchema
    },
    async ({ topic, window_hours }) => {
      const pattern = `%${escapeLikeLiteral(topic)}%`;
      const { rows } = await pool.query(MOMENTUM_SQL, [window_hours, pattern]);
      const { distinct_mentions, distinct_sources } = rows[0];
      const windowDays = window_hours / 24;
      const velocity_per_day = distinct_mentions / windowDays;
      const saturation_penalty = saturationPenalty(distinct_mentions);
      const score =
        distinct_sources * distinct_mentions * velocity_per_day * (1 - saturation_penalty);
      const payload = {
        topic,
        window_hours,
        distinct_sources,
        distinct_mentions,
        velocity_per_day: Number(velocity_per_day.toFixed(3)),
        saturation_penalty: Number(saturation_penalty.toFixed(3)),
        score: Number(score.toFixed(3))
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      };
    }
  );
}
