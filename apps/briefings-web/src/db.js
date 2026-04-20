import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const ssl = process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };

export const pool = new Pool({ connectionString, ssl });

const SLOT_ORDER = `CASE slot WHEN 'morning' THEN 1 WHEN 'midday' THEN 2 WHEN 'evening' THEN 3 END`;

export async function latestBriefing() {
  const { rows } = await pool.query(
    `SELECT date, slot, markdown, html, generated_at
       FROM briefings
       ORDER BY date DESC, ${SLOT_ORDER} DESC
       LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function getBriefing(date, slot) {
  const { rows } = await pool.query(
    `SELECT date, slot, markdown, html, generated_at
       FROM briefings
       WHERE date = $1 AND slot = $2`,
    [date, slot]
  );
  return rows[0] ?? null;
}

export async function recentBriefings(limit = 14) {
  const { rows } = await pool.query(
    `SELECT date, slot, generated_at
       FROM briefings
       ORDER BY date DESC, ${SLOT_ORDER} DESC
       LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function archivePage(page = 1, pageSize = 30) {
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(
    `SELECT date, slot, generated_at
       FROM briefings
       ORDER BY date DESC, ${SLOT_ORDER} DESC
       LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  const {
    rows: [{ count }]
  } = await pool.query('SELECT COUNT(*)::int AS count FROM briefings');
  return { rows, total: count, page, pageSize };
}

export async function feedItems(limit = 30) {
  const { rows } = await pool.query(
    `SELECT date, slot, markdown, generated_at
       FROM briefings
       ORDER BY date DESC, ${SLOT_ORDER} DESC
       LIMIT $1`,
    [limit]
  );
  return rows;
}
