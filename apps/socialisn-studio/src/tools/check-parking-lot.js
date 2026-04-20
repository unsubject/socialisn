import { z } from 'zod';
import { pool } from '../db.js';
import {
  googleTasksConfigured,
  findTasksListId,
  listTasks
} from '../google/tasks.js';
import {
  classifyAudienceFit,
  saturationPenalty,
  escapeLikeLiteral,
  DEAD_HOURS
} from '../lib/scoring.js';

const InputSchema = {
  window_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(168)
    .describe(
      'Look-back window used to score each task\'s cross-source momentum. Default 168h (1 week).'
    ),
  list_name: z
    .string()
    .optional()
    .describe(
      'Google Tasks list name to read. Defaults to STUDIO_GOOGLE_TASKS_LIST_NAME or "Subjects".'
    )
};

const MOMENTUM_SQL = `
WITH hits AS (
  SELECT 'newsletter'::text AS source_type, nl.sender_name AS source_name, nl.fetched_at
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
  SELECT 'news'::text, n.source_name, n.fetched_at
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
  SELECT 'youtube'::text, y.channel_name, y.fetched_at
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
  SELECT 'podcast'::text, p.podcast_name, p.fetched_at
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
  COUNT(DISTINCT (source_type, source_name))::int AS distinct_sources,
  MIN(fetched_at) AS first_seen_at
FROM hits
`;

function classifyTask({ mentions, sources, firstSeen, audienceFit }) {
  if (mentions === 0) return 'cold';
  const hoursSince = firstSeen ? (Date.now() - firstSeen.getTime()) / 3600000 : null;
  const dead = DEAD_HOURS[audienceFit];
  if (hoursSince !== null && hoursSince > dead) return 'stale';
  if (mentions >= 3 && sources >= 2) return 'ripe_now';
  if (mentions >= 1) return 'ripe_soon';
  return 'cold';
}

export function registerCheckParkingLot(server) {
  server.registerTool(
    'check_parking_lot',
    {
      title: 'Check parking lot',
      description:
        'Reads the user\'s Google Tasks "Subjects" list (the Idea Parking Lot), scores each task\'s cross-source momentum over the window, and classifies as "ripe_now" (strong signal + still in freshness window), "ripe_soon" (signals forming), "cold" (no signal), or "stale" (HK subject past 48h, or other audience-fit past its dead window). Results sorted by priority (ripe_now first) then by distinct_mentions. Requires STUDIO_GOOGLE_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN; see docs/google-tasks-setup.md.',
      inputSchema: InputSchema
    },
    async ({ window_hours, list_name }) => {
      if (!googleTasksConfigured()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'google_tasks_not_configured',
                  detail:
                    'Set STUDIO_GOOGLE_CLIENT_ID, STUDIO_GOOGLE_CLIENT_SECRET, STUDIO_GOOGLE_REFRESH_TOKEN on the studio service. See docs/google-tasks-setup.md.'
                },
                null,
                2
              )
            }
          ]
        };
      }

      const effectiveListName =
        list_name || process.env.STUDIO_GOOGLE_TASKS_LIST_NAME || 'Subjects';

      try {
        let listId = process.env.STUDIO_GOOGLE_TASKS_LIST_ID;
        if (!listId) listId = await findTasksListId(effectiveListName);
        if (!listId) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'list_not_found',
                    detail: `No Google Tasks list named "${effectiveListName}" in this account.`
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        const tasks = await listTasks(listId);
        const classified = [];
        for (const task of tasks) {
          const subject = (task.title || '').trim();
          if (!subject) continue;
          const pattern = `%${escapeLikeLiteral(subject)}%`;
          const { rows } = await pool.query(MOMENTUM_SQL, [window_hours, pattern]);
          const { distinct_mentions, distinct_sources, first_seen_at } = rows[0];
          const audienceFit = classifyAudienceFit(subject);
          const firstSeen =
            first_seen_at instanceof Date
              ? first_seen_at
              : first_seen_at
              ? new Date(first_seen_at)
              : null;
          const classification = classifyTask({
            mentions: distinct_mentions,
            sources: distinct_sources,
            firstSeen,
            audienceFit
          });
          const velocity = distinct_mentions / (window_hours / 24);
          classified.push({
            task_id: task.id,
            subject,
            notes: task.notes || null,
            audience_fit: audienceFit,
            classification,
            momentum: {
              distinct_sources,
              distinct_mentions,
              velocity_per_day: Number(velocity.toFixed(3)),
              saturation_penalty: Number(saturationPenalty(distinct_mentions).toFixed(3))
            },
            first_seen_at: firstSeen ? firstSeen.toISOString() : null,
            task_updated: task.updated || null
          });
        }

        const priority = { ripe_now: 0, ripe_soon: 1, stale: 2, cold: 3 };
        classified.sort(
          (a, b) =>
            priority[a.classification] - priority[b.classification] ||
            b.momentum.distinct_mentions - a.momentum.distinct_mentions
        );

        const payload = {
          list_name: effectiveListName,
          list_id: listId,
          window_hours,
          task_count: classified.length,
          by_classification: {
            ripe_now: classified.filter((t) => t.classification === 'ripe_now').length,
            ripe_soon: classified.filter((t) => t.classification === 'ripe_soon').length,
            cold: classified.filter((t) => t.classification === 'cold').length,
            stale: classified.filter((t) => t.classification === 'stale').length
          },
          tasks: classified
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
        };
      } catch (err) {
        console.error('[check_parking_lot] error:', err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'google_tasks_api_error',
                  detail: err.message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );
}
