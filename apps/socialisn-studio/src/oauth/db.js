import { randomBytes, createHash } from 'node:crypto';
import { pool } from '../db.js';

function genToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export async function registerClient({ client_name, redirect_uris }) {
  const client_id = genToken(16);
  await pool.query(
    `INSERT INTO studio_oauth_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, $3)`,
    [client_id, client_name || null, redirect_uris]
  );
  return { client_id, client_name: client_name || null, redirect_uris };
}

export async function getClient(client_id) {
  if (!client_id) return null;
  const { rows } = await pool.query(
    `SELECT client_id, client_name, redirect_uris
       FROM studio_oauth_clients
      WHERE client_id = $1`,
    [client_id]
  );
  return rows[0] || null;
}

export async function createAuthCode({
  client_id, redirect_uri, code_challenge, code_challenge_method,
  scope, resource, ttlSeconds = 600
}) {
  const code = genToken(32);
  const expires_at = new Date(Date.now() + ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO studio_oauth_codes
       (code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [code, client_id, redirect_uri, code_challenge, code_challenge_method, scope || null, resource || null, expires_at]
  );
  return code;
}

export async function consumeAuthCode(code) {
  if (!code) return null;
  const { rows } = await pool.query(
    `UPDATE studio_oauth_codes
        SET used_at = NOW()
      WHERE code = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource`,
    [code]
  );
  return rows[0] || null;
}

export async function issueToken({ token_type, client_id, scope, resource, ttlSeconds }) {
  const token = genToken(32);
  const expires_at = new Date(Date.now() + ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO studio_oauth_tokens
       (token, token_type, client_id, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [token, token_type, client_id, scope || null, resource || null, expires_at]
  );
  return { token, expires_at };
}

export async function validateAccessToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT token, token_type, client_id, scope, resource, expires_at
       FROM studio_oauth_tokens
      WHERE token = $1
        AND token_type = 'access'
        AND expires_at > NOW()
        AND revoked_at IS NULL`,
    [token]
  );
  return rows[0] || null;
}

export async function consumeRefreshToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `UPDATE studio_oauth_tokens
        SET revoked_at = NOW()
      WHERE token = $1
        AND token_type = 'refresh'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      RETURNING client_id, scope, resource`,
    [token]
  );
  return rows[0] || null;
}

export function hashCodeVerifier(code_verifier) {
  return createHash('sha256').update(code_verifier).digest('base64url');
}
