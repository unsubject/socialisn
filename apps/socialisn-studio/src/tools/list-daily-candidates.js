import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import {
  classifyAudienceFit,
  saturationPenalty,
  DEAD_HOURS
} from '../lib/scoring.js';
import {
  googleTasksConfigured,
  findTasksListId,
  listTasks
} from '../google/tasks.js';

const InputSchema = {
  track: z
    .enum(['youtube', 'podcast'])
    .describe(
      'Content track. "youtube" favors broad-reach common concerns; "podcast" favors depth and unique angle.'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .default(5)
    .describe('Max candidates to return after ranking and track-distinction.'),
  window_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 14)
    .default(72)
    .describe('Look-back window over enriched items. Default 72 hours.'),
  min_mentions: z
    .number()
    .int()
    .positive()
    .default(2)
    .describe('Minimum distinct items mentioning the subject to be eligible.')
};

const CANDIDATES_SQL = `
WITH item_corpus AS (
  SELECT 'newsletter'::text AS source_type,
         nl.sender_name     AS source_name,
         nl.message_id      AS item_id,
         nl.subject         AS title,
         nl.fetched_at,
         e.summary_zh,
         e.keywords_zh
    FROM newsletter_items nl
    JOIN item_enrichment e
      ON e.item_type = 'newsletter' AND e.item_id = nl.message_id
   WHERE nl.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND e.keywords_zh IS NOT NULL
     AND array_length(e.keywords_zh, 1) > 0
  UNION ALL
  SELECT 'news'::text, n.source_name, n.article_id, n.headline, n.fetched_at,
         e.summary_zh, e.keywords_zh
    FROM news_items n
    JOIN item_enrichment e
      ON e.item_type = 'news' AND e.item_id = n.article_id
   WHERE n.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND e.keywords_zh IS NOT NULL
     AND array_length(e.keywords_zh, 1) > 0
  UNION ALL
  SELECT 'youtube'::text, y.channel_name, y.video_id, y.title, y.fetched_at,
         e.summary_zh, e.keywords_zh
    FROM youtube_items y
    JOIN item_enrichment e
      ON e.item_type = 'youtube' AND e.item_id = y.video_id
   WHERE y.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND e.keywords_zh IS NOT NULL
     AND array_length(e.keywords_zh, 1) > 0
  UNION ALL
  SELECT 'podcast'::text, p.podcast_name, p.episode_id, p.title, p.fetched_at,
         e.summary_zh, e.keywords_zh
    FROM podcast_items p
    JOIN item_enrichment e
      ON e.item_type = 'podcast' AND e.item_id = p.episode_id
   WHERE p.fetched_at >= NOW() - make_interval(hours => $1::int)
     AND e.keywords_zh IS NOT NULL
     AND array_length(e.keywords_zh, 1) > 0
),
exploded AS (
  SELECT source_type, source_name, item_id, title, fetched_at, summary_zh,
         BTRIM(UNNEST(keywords_zh)) AS subject
    FROM item_corpus
)
SELECT
  subject,
  COUNT(DISTINCT item_id)::int                    AS distinct_mentions,
  COUNT(DISTINCT (source_type, source_name))::int AS distinct_sources,
  MIN(fetched_at)                                 AS first_seen_at,
  MAX(fetched_at)                                 AS last_seen_at,
  (array_agg(title ORDER BY fetched_at DESC))[1:3]                             AS sample_titles,
  (array_agg(summary_zh ORDER BY fetched_at DESC) FILTER (WHERE summary_zh IS NOT NULL))[1:3] AS sample_summaries
  FROM exploded
 WHERE LENGTH(subject) > 1
 GROUP BY subject
HAVING COUNT(DISTINCT item_id) >= $2::int
 ORDER BY COUNT(DISTINCT item_id) DESC
 LIMIT 200
`;

const INSERT_SQL = `
INSERT INTO studio_candidate_scores
  (run_id, run_at, track, rank, subject, score, distinct_sources, distinct_mentions,
   velocity_per_day, saturation_penalty, audience_fit, first_seen_at, window_hours)
VALUES
  ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`;

const TRACK_WEIGHTS = {
  youtube: { 'macro-econ': 1.0, 'hong-kong': 1.0, mixed: 0.6, history: 0.4 },
  podcast: { history: 1.0, 'macro-econ': 0.85, 'hong-kong': 0.7, mixed: 0.5 }
};

function oneLineSummary(samples) {
  const first = (samples || []).find((s) => typeof s === 'string' && s.trim().length > 0);
  if (!first) return '';
  const clean = first.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 117) + '…' : clean;
}

async function fetchParkingLotEntries() {
  if (!googleTasksConfigured()) return null;
  try {
    const listName = process.env.STUDIO_GOOGLE_TASKS_LIST_NAME || 'Subjects';
    const listId =
      process.env.STUDIO_GOOGLE_TASKS_LIST_ID || (await findTasksListId(listName));
    if (!listId) return null;
    const tasks = await listTasks(listId);
    return tasks
      .map((t) => ({ id: t.id, title: (t.title || '').trim() }))
      .filter((t) => t.title);
  } catch (err) {
    console.error('[list_daily_candidates] parking lot fetch failed:', err.message);
    return null;
  }
}

function fuzzyMatchParkingLot(subject, entries) {
  if (!entries || entries.length === 0) return false;
  const subj = subject.trim();
  if (!subj) return false;
  const exact = entries.find((e) => e.title === subj);
  if (exact) return { task_id: exact.id, task_title: exact.title, match: 'exact' };
  const substr = entries.find((e) => e.title.includes(subj) || subj.includes(e.title));
  if (substr)
    return { task_id: substr.id, task_title: substr.title, match: 'substring' };
  return false;
}

function buildCandidate(row, windowDays, parkingLot) {
  const mentions = row.distinct_mentions;
  const sources = row.distinct_sources;
  const velocity = mentions / windowDays;
  const satPenalty = saturationPenalty(mentions);
  const momentumScore = sources * mentions * velocity * (1 - satPenalty);
  const audienceFit = classifyAudienceFit(row.subject, row.sample_titles);
  const firstSeenAt =
    row.first_seen_at instanceof Date ? row.first_seen_at : new Date(row.first_seen_at);
  const hoursSinceFirst = (Date.now() - firstSeenAt.getTime()) / 3600000;
  const deadHours = DEAD_HOURS[audienceFit];
  const hoursRemaining = Math.max(0, deadHours - hoursSinceFirst);
  return {
    subject: row.subject,
    sample_titles: row.sample_titles || [],
    sample_summaries: row.sample_summaries || [],
    one_line_summary: oneLineSummary(row.sample_summaries),
    distinct_sources: sources,
    distinct_mentions: mentions,
    velocity_per_day: Number(velocity.toFixed(3)),
    saturation_penalty: Number(satPenalty.toFixed(3)),
    coverage_density: Math.round(satPenalty * 100),
    momentum_score: Number(momentumScore.toFixed(3)),
    audience_fit: audienceFit,
    first_seen_at: firstSeenAt.toISOString(),
    hours_remaining: Number(hoursRemaining.toFixed(1)),
    dead: hoursRemaining <= 0,
    parking_lot_match: fuzzyMatchParkingLot(row.subject, parkingLot)
  };
}

function explainTrackFit(c, track, weight) {
  if (track === 'youtube') {
    if (weight >= 1.0) {
      return c.coverage_density < 50
        ? 'Broad-reach fit: common concern, discourse not yet saturated — room for a delivery-level differentiated take.'
        : 'Broad-reach fit: common concern; saturation is high, angle must differentiate at the delivery level.';
    }
    return weight >= 0.6
      ? 'Partial YouTube fit: audience overlap is mixed; lead with a hook that frames for a broader viewer.'
      : 'Weak YouTube fit: primarily history/depth-oriented; consider saving for podcast track.';
  }
  if (c.audience_fit === 'history') {
    return 'Deep-dive fit: history-flavored topic rewards longer, more essayistic treatment.';
  }
  if (c.coverage_density < 40) {
    return 'Deep-dive fit: low coverage density — niche space to establish unique perspective.';
  }
  return weight >= 0.7
    ? 'Podcast fit: treat as members-exclusive deep-dive with data + contrarian read.'
    : 'Weak podcast fit: better suited to YouTube broad-reach framing.';
}

function rankForTrack(candidates, track) {
  const weights = TRACK_WEIGHTS[track];
  return candidates
    .filter((c) => !c.dead)
    .map((c) => {
      const w = weights[c.audience_fit] ?? weights.mixed;
      return {
        ...c,
        track_weight: w,
        track_score: Number((c.momentum_score * w).toFixed(3)),
        track_rationale: explainTrackFit(c, track, w)
      };
    })
    .sort((a, b) => b.track_score - a.track_score);
}

function applyTrackDistinction(ytList, pdList) {
  if (!ytList.length || !pdList.length) return { ytList, pdList };
  if (ytList[0].subject !== pdList[0].subject) return { ytList, pdList };
  const shared = ytList[0].subject;
  if (ytList[0].track_score >= pdList[0].track_score) {
    return { ytList, pdList: pdList.filter((c) => c.subject !== shared) };
  }
  return { ytList: ytList.filter((c) => c.subject !== shared), pdList };
}

export function registerListDailyCandidates(server) {
  server.registerTool(
    'list_daily_candidates',
    {
      title: 'List daily candidate subjects',
      description:
        'Shortlists ranked subjects for the requested track. "youtube" = broad-reach common concerns, "podcast" = deep-dive unique angle. Subjects are harvested from item_enrichment.keywords_zh across newsletter/news/YouTube/podcast in the window. Ranking = distinct_sources × distinct_mentions × velocity_per_day × (1 − saturation_penalty) × track-weighted audience-fit. Emits coverage_density (0–100), hours_remaining in the freshness window (HK dead at 48h; macro/history at 168h), and a plain-English track_rationale. The #1 youtube pick is guaranteed different from the #1 podcast pick. parking_lot_match is {task_id, task_title, match} when the subject fuzzy-matches a Google Tasks "Subjects" entry; false otherwise (or when Google isn\'t configured).',
      inputSchema: InputSchema
    },
    async ({ track, limit, window_hours, min_mentions }) => {
      const windowDays = window_hours / 24;
      const parkingLot = await fetchParkingLotEntries();
      const { rows } = await pool.query(CANDIDATES_SQL, [window_hours, min_mentions]);
      const candidates = rows.map((r) => buildCandidate(r, windowDays, parkingLot));

      let ytList = rankForTrack(candidates, 'youtube');
      let pdList = rankForTrack(candidates, 'podcast');
      ({ ytList, pdList } = applyTrackDistinction(ytList, pdList));

      const selected = (track === 'youtube' ? ytList : pdList).slice(0, limit);

      const runId = randomUUID();
      for (let i = 0; i < selected.length; i++) {
        const c = selected[i];
        await pool.query(INSERT_SQL, [
          runId,
          track,
          i + 1,
          c.subject,
          c.track_score,
          c.distinct_sources,
          c.distinct_mentions,
          c.velocity_per_day,
          c.saturation_penalty,
          c.audience_fit,
          c.first_seen_at,
          window_hours
        ]);
      }

      const payload = {
        run_id: runId,
        track,
        window_hours,
        min_mentions,
        eligible_subjects: candidates.filter((c) => !c.dead).length,
        parking_lot_available: parkingLot !== null,
        returned: selected.length,
        candidates: selected.map((c, i) => ({
          rank: i + 1,
          subject: c.subject,
          one_line_summary: c.one_line_summary,
          audience_fit: c.audience_fit,
          track_weight: c.track_weight,
          track_score: c.track_score,
          track_rationale: c.track_rationale,
          momentum: {
            distinct_sources: c.distinct_sources,
            distinct_mentions: c.distinct_mentions,
            velocity_per_day: c.velocity_per_day,
            saturation_penalty: c.saturation_penalty
          },
          coverage_density: c.coverage_density,
          freshness: {
            first_seen_at: c.first_seen_at,
            hours_remaining: c.hours_remaining
          },
          sample_titles: c.sample_titles,
          sample_summaries: c.sample_summaries,
          parking_lot_match: c.parking_lot_match
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      };
    }
  );
}
