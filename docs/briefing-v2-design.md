# Briefing v2 — Design

_Locked: 2026-04-19. Supersedes `n8n/workflows/generate-briefing.ts`._

## Goals

Replace the single daily 23:30 UTC briefing with a three-slot, Eastern-Time pipeline that:

1. Pulls from every ingestion source this repo owns **plus** read-only joins to newsletter and frontierwatch2 tables.
2. Supports on-demand mid-day / evening refreshes via Telegram, with automatic scheduled backstops if no manual trigger fires.
3. Writes every final briefing to Postgres as the canonical source of truth — consumable by a future content-creation agent.
4. Serves briefings from a dedicated Railway site (not GitHub Pages), each briefing as its own URL.

## Slots

All times US Eastern, DST-aware via n8n `scheduleTrigger` `timezone: America/New_York`.

| Slot | Scheduled backstop | Telegram command | Delta cutoff |
|------|--------------------|------------------|--------------|
| `morning` | `0 8 * * *` | — | last 24h absolute |
| `midday`  | `0 14 * * *` | `/midday`  | morning row `generated_at` |
| `evening` | `0 20 * * *` | `/evening` | most recent of (midday, morning) `generated_at` |

### Skip-if-exists

Each scheduled cron opens by `SELECT generated_at FROM briefings WHERE date = today_ET AND slot = <own_slot>`. If a row exists (Telegram fired earlier in the window), the scheduled run exits as a no-op. A second Telegram call for a slot that already has a row regenerates in place (`ON CONFLICT (date, slot) DO UPDATE`).

### Empty-delta

Midday / evening: if `total_new_items == 0` after applying the cutoff, exit without calling the LLM. Scheduled run: log and return. Telegram run: reply to the chat with `"No new items since <prior slot>; skipping."`.

## Sources

Read-only joins in all three workflows (morning fetches last 24h; midday/evening apply the cutoff):

- `newsletter_items` + `item_enrichment` on `(item_type='newsletter', item_id=email_id)`
- `news_items` + `item_enrichment` on `(item_type='news', item_id=article_id)`
- `youtube_items` + `item_enrichment` on `(item_type='youtube', item_id=video_id)`
- `podcast_items` + `item_enrichment` on `(item_type='podcast', item_id=episode_id)`
- `frontier_briefings` (owned by `unsubject/frontierwatch2`) — read-only. Curated subset: include a sector's briefing only if `published_at >= NOW() - INTERVAL '24 hours'`. No regeneration; embed verbatim.

## Prompt shape (Sonnet 4.5)

Keep the existing Traditional Chinese voice ("利世民的個人情報助理"). Morning prompt asks for headlines + themes + stats + editor notes. Midday / evening prompts are framed explicitly as delta updates ("以下是自今晨簡報以來新增的資料…") and ask for a shorter, focused update rather than a full re-synthesis.

## Storage

Schema migration `infra/migrations/0002_briefings_slot_values.sql`:

```sql
ALTER TABLE briefings DROP CONSTRAINT IF EXISTS briefings_slot_check;
ALTER TABLE briefings ADD CONSTRAINT briefings_slot_check
  CHECK (slot IN ('morning', 'midday', 'evening'));
```

Existing rows with `slot = 'evening'` are kept as-is — they are historically valid evening briefings and will surface correctly in the new site.

Every generated briefing is upserted: `INSERT INTO briefings (date, slot, markdown, html, generated_at) ... ON CONFLICT (date, slot) DO UPDATE`. No separate table; the future content agent queries `briefings` directly.

## Static site — `apps/briefings-web/`

**Stack**: Node + Hono, deployed as a new Railway service in the same project as the existing Postgres. Connects via `DATABASE_URL` service reference. Server-renders every request from `briefings.html`; no static file generation, no repo commits.

**Routes**:

| Path | Purpose |
|------|---------|
| `GET /` | Latest briefing + sidebar of last 14 days |
| `GET /b/:date/:slot` | Specific briefing; `slot ∈ morning\|midday\|evening` |
| `GET /archive` | Paginated index of all briefings |
| `GET /feed.xml` | RSS 2.0, one `<item>` per briefing |
| `GET /healthz` | Liveness |

**Caching**: `Cache-Control: public, max-age=300` on briefing pages.

**Domain**: `briefings.<your-domain>` via Railway custom domain + CNAME.

## Telegram

One bot, two commands: `/midday`, `/evening`. n8n Telegram Trigger node receives updates; a Switch node routes by command text to an Execute Workflow call against the corresponding briefing workflow. Bot token stored as an n8n credential. After generation, reply to the chat with slot, item count, and site URL. Telegram's bot-token model handles auth — no additional webhook secret needed.

## Credentials (must be fixed when writing new workflow files)

The old `generate-briefing.ts` references names that do not exist on the instance. New files must use the actual names:

- Postgres: **`Railway`** (not `Postgres`)
- Gmail OAuth2: **`Gmail account`** (not `Gmail`) — the new flow does not send email, so Gmail is no longer needed here
- Anthropic: **`Anthropic API Key`** (not `Anthropic`)

## Repo structure additions

```
apps/briefings-web/
  package.json
  src/server.ts           # Hono routes
  src/render.ts           # RSS + list rendering helpers
  src/db.ts               # pg client
  railway.json
infra/migrations/
  0002_briefings_slot_values.sql
n8n/workflows/
  generate-briefing-morning.ts
  generate-briefing-midday.ts
  generate-briefing-evening.ts
docs/briefing-v2-design.md  # this file
```

Delete on cutover:

- `n8n/workflows/generate-briefing.ts`
- `docs/briefings/*.html` (keep `.gitkeep`)

Archive (don't delete) on cutover:

- n8n workflow `Generate Daily Briefing` (`F0g69WDiNUX0OXNW`)

## Implementation phases

1. Commit this design doc + handoff update. **[current commit]**
2. Schema migration `0002_briefings_slot_values.sql`.
3. Build + deploy `apps/briefings-web/` to Railway; point custom domain. Verifiable with existing DB data before any workflow changes.
4. Rewrite morning workflow (`generate-briefing-morning.ts`); fix stale credential names; add newsletter + frontier joins; drop email + save steps.
5. Build midday + evening delta workflows.
6. Wire Telegram bot + command router in n8n.
7. Activate v2, archive v1 workflow, wipe `docs/briefings/*.html`.

## Out of scope

- Email delivery (removed; the new site + RSS replace the inbox workflow).
- Evening content migration into the new `evening` slot beyond keeping the historical rows.
- Any write path to `frontier_*` tables — socialisn remains strictly read-only there.
