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
     ON studio_candidate_scores(run_at DESC)`,
  `CREATE TABLE IF NOT EXISTS studio_oauth_clients (
     client_id TEXT PRIMARY KEY,
     client_name TEXT,
     redirect_uris TEXT[] NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS studio_oauth_codes (
     code TEXT PRIMARY KEY,
     client_id TEXT NOT NULL REFERENCES studio_oauth_clients(client_id) ON DELETE CASCADE,
     redirect_uri TEXT NOT NULL,
     code_challenge TEXT NOT NULL,
     code_challenge_method TEXT NOT NULL,
     scope TEXT,
     resource TEXT,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS studio_oauth_tokens (
     token TEXT PRIMARY KEY,
     token_type TEXT NOT NULL,
     client_id TEXT NOT NULL REFERENCES studio_oauth_clients(client_id) ON DELETE CASCADE,
     scope TEXT,
     resource TEXT,
     expires_at TIMESTAMPTZ NOT NULL,
     revoked_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS studio_oauth_tokens_access_lookup_idx
     ON studio_oauth_tokens(token)
     WHERE token_type = 'access' AND revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS studio_oauth_codes_expires_idx
     ON studio_oauth_codes(expires_at)
     WHERE used_at IS NULL`
];

export async function runMigrations() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
}
