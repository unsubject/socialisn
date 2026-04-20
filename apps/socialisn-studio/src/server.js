import { createServer } from 'node:http';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.PORT || 3000);
const BEARER_TOKEN = process.env.STUDIO_BEARER_TOKEN;
if (!BEARER_TOKEN) {
  throw new Error('STUDIO_BEARER_TOKEN is required');
}

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

function buildMcpServer() {
  const server = new McpServer({
    name: 'socialisn-studio',
    version: '0.1.0'
  });
  // Tools land here in phase 2.1 step 2+.
  // See docs/phase-2-spec.md §"Phase 2.1 — MCP tools".
  return server;
}

async function handleMcp(req, res) {
  if (req.headers.authorization !== `Bearer ${BEARER_TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  try {
    const server = buildMcpServer();
    // Stateless: fresh server + transport per request. Flip to sessionful
    // (sessionIdGenerator set) if a tool needs to stream progress back.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('MCP error:', err);
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

httpServer.listen(PORT, () => {
  console.log(`socialisn-studio listening on :${PORT}`);
});
