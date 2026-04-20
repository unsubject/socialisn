#!/usr/bin/env node
// One-time local OAuth dance to capture a Google Tasks refresh token for
// socialisn-studio. Node 20+ only (uses built-in fetch). No deps.
//
// Prereq: OAuth client (Desktop app type) created in Google Cloud Console
// with the Tasks API enabled. See docs/google-tasks-setup.md.
//
// Usage:
//   STUDIO_GOOGLE_CLIENT_ID=... STUDIO_GOOGLE_CLIENT_SECRET=... \
//     node scripts/google-auth.mjs
//
// The script prints a refresh_token to stdout — copy it into Railway
// Variables as STUDIO_GOOGLE_REFRESH_TOKEN.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const CLIENT_ID = process.env.STUDIO_GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.STUDIO_GOOGLE_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 7777);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/tasks';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('STUDIO_GOOGLE_CLIENT_ID and STUDIO_GOOGLE_CLIENT_SECRET must be set in env.');
  console.error('Get them from Google Cloud Console → APIs & Services → Credentials (OAuth 2.0 Client ID).');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('state', state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  if (gotState !== state) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('state mismatch');
    console.error('\nCSRF state mismatch. Abort.');
    process.exit(1);
  }
  if (!code) {
    const err = url.searchParams.get('error') || 'no code';
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Error: ${err}`);
    console.error('\nOAuth error:', err);
    process.exit(1);
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('Token exchange failed');
      console.error('\nToken exchange failed:', data);
      process.exit(1);
    }
    if (!data.refresh_token) {
      res
        .writeHead(500, { 'content-type': 'text/plain' })
        .end('No refresh_token returned. Revoke the grant at myaccount.google.com/permissions and try again.');
      console.error(
        '\nNo refresh_token in response. Google only returns one on first consent.'
      );
      console.error(
        'To fix: visit https://myaccount.google.com/permissions, revoke the app, then re-run this script.'
      );
      console.error('Raw response:', data);
      process.exit(1);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><html><body style="font:15px system-ui;max-width:480px;margin:80px auto;padding:0 24px"><h1>Done</h1><p>You can close this tab. The refresh token is printed in the terminal that ran this script.</p></body></html>'
    );
    console.log('\n=== REFRESH TOKEN ===');
    console.log(data.refresh_token);
    console.log('\nAdd this to Railway → studio service → Variables as STUDIO_GOOGLE_REFRESH_TOKEN.');
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    console.error('\n', err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log('Opening browser to Google consent screen...');
  console.log('If the browser does not open, paste this URL:');
  console.log(authUrl.toString());
  exec(`open "${authUrl.toString()}"`);
});
