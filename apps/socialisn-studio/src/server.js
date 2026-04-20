import { createServer } from 'node:http';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerSearchDiscourse } from './tools/search-discourse.js';
import { registerMomentum } from './tools/momentum.js';
import { registerListDailyCandidates } from './tools/list-daily-candidates.js';
import { registerBuildThesisBrief } from './tools/build-thesis-brief.js';
import { runMigrations } from './migrations.js';
import { attachOauthRoutes, oauthEnabled } from './oauth/routes.js';
import { validateAccessToken } from './oauth/db.js';

const PORT = Number(process.env.PORT || 3000);
const BEARER_TOKEN = process.env.STUDIO_BEARER_TOKEN || null;
const ADMIN_PASSWORD = process.env.STUDIO_ADMIN_PASSWORD || null;
const BASE_URL = process.env.STUDIO_BASE_URL || null;

if (!BEARER_TOKEN && !ADMIN_PASSWORD) {
  throw new Error('At least one of STUDIO_BEARER_TOKEN or STUDIO_ADMIN_PASSWORD must be set');
}
if (ADMIN_PASSWORD && !BASE_URL) {
  throw new Error('STUDIO_BASE_URL is required when STUDIO_ADMIN_PASSWORD is set');
}

const app = new Hono();

app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  console.log(`[http] ${method} ${path} ${status} ${ms}ms`);
});

app.get('/healthz', (c) => c.text('ok'));
attachOauthRoutes(app);

function buildMcpServer() {
  const server = new McpServer({
    name: 'socialisn-studio',
    version: '0.5.1'
  });
  registerSearchDiscourse(server);
  registerMomentum(server);
  registerListDailyCandidates(server);
  registerBuildThesisBrief(server);
  return server;
}

function wwwAuthenticateChallenge() {
  if (!oauthEnabled()) return 'Bearer';
  return `Bearer resource_metadata="${BASE_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource"`;
}

async function authorizeMcpRequest(req) {
  const raw = req.headers.authorization;
  if (!raw || !/^bearer /i.test(raw)) return null;
  const token = raw.slice(raw.indexOf(' ') + 1).trim();
  if (!token) return null;
  if (BEARER_TOKEN && token === BEARER_TOKEN) {
    return { mode: 'legacy' };
  }
  if (oauthEnabled()) {
    const row = await validateAccessToken(token);
    if (row) return { mode: 'oauth', client_id: row.client_id };
  }
  return null;
}

async function handleMcp(req, res) {
  const start = Date.now();
  const method = req.method;
  const auth = await authorizeMcpRequest(req);
  if (!auth) {
    const ms = Date.now() - start;
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': wwwAuthenticateChallenge()
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    console.log(`[mcp] ${method} /mcp 401 unauth ${ms}ms`);
    return;
  }

  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    res.on('close', () => {
      transport.close();
      server.close();
      const ms = Date.now() - start;
      console.log(`[mcp] ${method} /mcp ${res.statusCode} ${auth.mode} ${ms}ms`);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp] error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  }
}

const honoListener = getRequestListener(app.fetch);

const httpServer = createServer((req, res) => {
  if (req.url && req.url.startsWith('/mcp')) {
    handleMcp(req, res);
    return;
  }
  honoListener(req, res);
});

async function main() {
  await runMigrations();
  httpServer.listen(PORT, () => {
    console.log(
      `socialisn-studio listening on :${PORT} ` +
      `(oauth ${oauthEnabled() ? 'enabled' : 'disabled'}, ` +
      `legacy bearer ${BEARER_TOKEN ? 'enabled' : 'disabled'})`
    );
  });
}

main().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
