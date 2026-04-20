import {
  registerClient, getClient, createAuthCode, consumeAuthCode,
  issueToken, consumeRefreshToken, hashCodeVerifier
} from './db.js';
import { renderLoginPage } from './login-page.js';

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

export function oauthEnabled() {
  return Boolean(process.env.STUDIO_ADMIN_PASSWORD && process.env.STUDIO_BASE_URL);
}

function issuer() {
  return process.env.STUDIO_BASE_URL.replace(/\/$/, '');
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '(none)';
}

export function attachOauthRoutes(app) {
  if (!oauthEnabled()) return;

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const iss = issuer();
    return c.json({
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      registration_endpoint: `${iss}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp']
    });
  });

  app.get('/.well-known/oauth-protected-resource', (c) => {
    const iss = issuer();
    return c.json({
      resource: `${iss}/mcp`,
      authorization_servers: [iss],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp']
    });
  });

  app.post('/register', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      console.log('[oauth] register: invalid JSON');
      return c.json({ error: 'invalid_client_metadata', error_description: 'body must be JSON' }, 400);
    }
    const redirect_uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    if (redirect_uris.length === 0) {
      console.log('[oauth] register: missing redirect_uris');
      return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' }, 400);
    }
    const client = await registerClient({
      client_name: typeof body.client_name === 'string' ? body.client_name : null,
      redirect_uris
    });
    console.log(`[oauth] register: client=${shortId(client.client_id)} redirects=${redirect_uris.length} name=${JSON.stringify(client.client_name)}`);
    return c.json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    }, 201);
  });

  app.get('/authorize', async (c) => {
    const q = c.req.query();
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method } = q;
    if (response_type !== 'code') {
      console.log(`[oauth] authorize GET: unsupported response_type=${response_type}`);
      return c.text('unsupported_response_type: only "code" is supported', 400);
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      console.log(`[oauth] authorize GET: missing/invalid PKCE method=${code_challenge_method}`);
      return c.text('invalid_request: PKCE with S256 required', 400);
    }
    if (!client_id || !redirect_uri) {
      console.log('[oauth] authorize GET: missing client_id or redirect_uri');
      return c.text('invalid_request: client_id and redirect_uri required', 400);
    }
    const client = await getClient(client_id);
    if (!client) {
      console.log(`[oauth] authorize GET: unknown client=${shortId(client_id)}`);
      return c.text('invalid_request: unknown client_id', 400);
    }
    if (!client.redirect_uris.includes(redirect_uri)) {
      console.log(`[oauth] authorize GET: redirect_uri mismatch client=${shortId(client_id)} got=${redirect_uri}`);
      return c.text('invalid_request: redirect_uri not registered', 400);
    }
    console.log(`[oauth] authorize GET: show login client=${shortId(client_id)} redirect=${redirect_uri}`);
    return c.html(renderLoginPage({
      client_id,
      client_name: client.client_name,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope: q.scope,
      state: q.state,
      resource: q.resource,
      error: null
    }));
  });

  app.post('/authorize', async (c) => {
    const form = await c.req.formData();
    const client_id = String(form.get('client_id') || '');
    const redirect_uri = String(form.get('redirect_uri') || '');
    const code_challenge = String(form.get('code_challenge') || '');
    const code_challenge_method = String(form.get('code_challenge_method') || '');
    const scope = form.get('scope') ? String(form.get('scope')) : null;
    const state = form.get('state') ? String(form.get('state')) : null;
    const resource = form.get('resource') ? String(form.get('resource')) : null;
    const password = String(form.get('password') || '');

    const client = await getClient(client_id);
    if (!client) {
      console.log(`[oauth] authorize POST: unknown client=${shortId(client_id)}`);
      return c.text('invalid_request: unknown client_id', 400);
    }
    if (!client.redirect_uris.includes(redirect_uri)) {
      console.log(`[oauth] authorize POST: redirect_uri mismatch client=${shortId(client_id)}`);
      return c.text('invalid_request: redirect_uri not registered', 400);
    }

    if (password !== process.env.STUDIO_ADMIN_PASSWORD) {
      console.log(`[oauth] authorize POST: wrong password client=${shortId(client_id)}`);
      return c.html(renderLoginPage({
        client_id,
        client_name: client.client_name,
        redirect_uri,
        code_challenge,
        code_challenge_method,
        scope,
        state,
        resource,
        error: 'Wrong password.'
      }), 401);
    }

    const code = await createAuthCode({
      client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource
    });
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    console.log(`[oauth] authorize POST: issued code client=${shortId(client_id)} redirect=${redirect_uri} state=${state ? 'yes' : 'no'}`);
    return c.redirect(url.toString(), 302);
  });

  app.post('/token', async (c) => {
    const form = await c.req.formData();
    const grant_type = String(form.get('grant_type') || '');

    if (grant_type === 'authorization_code') {
      const code = String(form.get('code') || '');
      const code_verifier = String(form.get('code_verifier') || '');
      const client_id = String(form.get('client_id') || '');
      if (!code || !code_verifier || !client_id) {
        console.log(`[oauth] token POST: invalid_request code=${code ? 'y' : 'n'} verifier=${code_verifier ? 'y' : 'n'} client=${client_id ? 'y' : 'n'}`);
        return c.json({ error: 'invalid_request' }, 400);
      }
      const row = await consumeAuthCode(code);
      if (!row) {
        console.log(`[oauth] token POST: code not found/expired client=${shortId(client_id)}`);
        return c.json({ error: 'invalid_grant' }, 400);
      }
      if (row.client_id !== client_id) {
        console.log(`[oauth] token POST: client_id mismatch code-client=${shortId(row.client_id)} request-client=${shortId(client_id)}`);
        return c.json({ error: 'invalid_grant' }, 400);
      }
      const hashed = hashCodeVerifier(code_verifier);
      if (hashed !== row.code_challenge) {
        console.log(`[oauth] token POST: code_verifier mismatch client=${shortId(client_id)}`);
        return c.json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' }, 400);
      }
      const access = await issueToken({
        token_type: 'access',
        client_id: row.client_id,
        scope: row.scope,
        resource: row.resource,
        ttlSeconds: ACCESS_TTL_SECONDS
      });
      const refresh = await issueToken({
        token_type: 'refresh',
        client_id: row.client_id,
        scope: row.scope,
        resource: row.resource,
        ttlSeconds: REFRESH_TTL_SECONDS
      });
      console.log(`[oauth] token POST: issued access+refresh client=${shortId(client_id)} scope=${row.scope || '-'}`);
      return c.json({
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: refresh.token,
        scope: row.scope
      });
    }

    if (grant_type === 'refresh_token') {
      const refresh_token = String(form.get('refresh_token') || '');
      if (!refresh_token) {
        console.log('[oauth] token POST: refresh missing');
        return c.json({ error: 'invalid_request' }, 400);
      }
      const row = await consumeRefreshToken(refresh_token);
      if (!row) {
        console.log('[oauth] token POST: refresh token not found/expired');
        return c.json({ error: 'invalid_grant' }, 400);
      }
      const access = await issueToken({
        token_type: 'access',
        client_id: row.client_id,
        scope: row.scope,
        resource: row.resource,
        ttlSeconds: ACCESS_TTL_SECONDS
      });
      const newRefresh = await issueToken({
        token_type: 'refresh',
        client_id: row.client_id,
        scope: row.scope,
        resource: row.resource,
        ttlSeconds: REFRESH_TTL_SECONDS
      });
      console.log(`[oauth] token POST: rotated refresh client=${shortId(row.client_id)}`);
      return c.json({
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: newRefresh.token,
        scope: row.scope
      });
    }

    console.log(`[oauth] token POST: unsupported_grant_type=${grant_type}`);
    return c.json({ error: 'unsupported_grant_type' }, 400);
  });
}
