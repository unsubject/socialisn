import { pool } from './db.js';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS studio_candidate_scores (
     run_id UUID NOT NULL,
     run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     track TEXT NOT NULL,
     rank INT NOT NULL,
     subject TEXT NOT NULL,
     score NUMERIC NOT NULL,
     distinct_sources INT NOT NULL,
     distinct_mentions INT NOT NULL,
     velocity_per_day NUMERIC NOT NULL,
     saturation_penalty NUMERIC NOT NULL,
     audience_fit TEXT NOT NULL,
     first_seen_at TIMESTAMPTZ,
     window_hours INT NOT NULL,
     PRIMARY KEY (run_id, track, rank)
   )`,
  `CREATE INDEX IF NOT EXISTS studio_candidate_scores_run_at_idx
     ON studio_candidate_scores(run_at DESC)`
];

export async function runMigrations() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
}
