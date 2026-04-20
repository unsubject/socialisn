import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  latestBriefing,
  getBriefing,
  recentBriefings,
  archivePage,
  feedItems
} from './db.js';
import {
  layout,
  renderSidebar,
  renderBriefing,
  renderArchive,
  renderFeed
} from './render.js';

const app = new Hono();

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const VALID_SLOTS = new Set(['morning', 'midday', 'evening']);

app.get('/healthz', (c) => c.text('ok'));

app.get('/', async (c) => {
  const [latest, recent] = await Promise.all([latestBriefing(), recentBriefings()]);
  if (!latest) {
    return c.html(
      layout({
        title: 'Socialisn Briefings',
        sidebar: renderSidebar([]),
        body:
          '<h1>尚未有簡報</h1><p>新簡報將於美東時間每日 08:00 自動生成。</p>'
      })
    );
  }
  const { title, body } = renderBriefing(latest);
  c.header('Cache-Control', 'public, max-age=300');
  return c.html(layout({ title, sidebar: renderSidebar(recent), body }));
});

app.get('/b/:date/:slot', async (c) => {
  const { date, slot } = c.req.param();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !VALID_SLOTS.has(slot)) {
    return c.notFound();
  }
  const [b, recent] = await Promise.all([getBriefing(date, slot), recentBriefings()]);
  if (!b) return c.notFound();
  const { title, body } = renderBriefing(b);
  c.header('Cache-Control', 'public, max-age=300');
  return c.html(layout({ title, sidebar: renderSidebar(recent), body }));
});

app.get('/archive', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || '1') || 1);
  const [archive, recent] = await Promise.all([archivePage(page, 30), recentBriefings()]);
  const body = renderArchive(archive);
  return c.html(
    layout({ title: '存檔 · Socialisn Briefings', sidebar: renderSidebar(recent), body })
  );
});

app.get('/feed.xml', async (c) => {
  const items = await feedItems(30);
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(renderFeed(items, SITE_URL));
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`briefings-web listening on :${info.port}`);
});
