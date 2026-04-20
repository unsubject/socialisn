# Phase 2 Spec — socialisn-studio

_Status: planning. Drafted 2026-04-20. Supersedes informal chat scoping._

socialisn evolves from a consumption/monitoring system into a **content-production assistant**. Phase 2 splits into:

- **Phase 2.1** — Pre-production: ideation → thesis → evidence → Traditional Chinese script.
- **Phase 2.2** — Post-production: Whisper SRT → cleaned SRT, GEMs, titles, chapters, teaser.

Both are delivered as a **remote MCP server** (working name: `socialisn-studio`) hosted on Railway at **`studio.socialisn.com`**. The user connects to it from any MCP-capable AI chat — Claude, Gemini, ChatGPT, Perplexity. No new UI is built; the AI chat is the interface, the MCP is the RAG + orchestration backend.

## Encoded constants

The studio knows these facts about the user; they are not restated per call.

- **Voice**: classical liberal, reasoned, evidence-based. Contrarian to sentimental/emotional mainstream.
- **Output language**: Traditional Chinese, Cantonese idiom.
- **Audience-fit ranking**: macro-economics > Hong Kong > history (Hong Kong history, history of economics).
- **Trend rule**: cross-source corroboration (distinct sources × distinct mentions × velocity) with a **saturation penalty** — "everyone is talking about it" lowers the score.
- **Freshness windows**:
  - HK subjects (government / market / economics / local society): **12h go-window, dead at 48h**.
  - Global economics / politics / technology: viable window **2 days to 1 week**.
- **Two-track rule with distinct subjects**:
  - **YouTube track** — broad-reach common concerns, delivery-level differentiation, occasional membership CTA.
  - **Members podcast track** — depth, unique perspective, arouses curiosity for exclusive content.
  - The two daily picks must be *different subjects*, not two angles on one.
- **"Counter-evidence" ≠ "counter-argument"**: studio surfaces facts, data, studies, documented statements that complicate the thesis — never rhetorical opposition.
- **Script constraint**: no fluff, efficient, 30-minute full-prose Traditional Chinese (≈ 4,500–6,000 characters, to be calibrated).

## Phase 2.1 — Pre-production

### MCP tools

**`list_daily_candidates(track, limit=5)`**
Returns a ranked shortlist for the given track (`"youtube"` or `"podcast"`). Each item:
- subject, one-line summary
- momentum breakdown (distinct sources, distinct mentions, velocity, saturation penalty)
- freshness: hours remaining in viable window
- audience-fit tag: `macro-econ` / `hong-kong` / `history` / mixed
- coverage density (0–100) — how saturated discourse is
- track rationale — why this is a YouTube vs. podcast subject
- parking-lot flag if the subject matches a Google Tasks "Subjects" entry

Track-distinction enforced: the top pick for YouTube and the top pick for podcast cannot be the same subject.

**`check_parking_lot()`**
Reads the user's Google Tasks list **"Subjects"** (the Idea Parking Lot). Cross-checks each entry against current public-sphere signals and classifies:
- `ripe now` — signals + freshness-window aligned, record this week
- `ripe soon` — signals forming
- `cold` — low signal
- `stale` — HK subject past 48h window

Intended for morning triage alongside the candidate lists.

**`build_thesis_brief(subject, user_direction)`**
User supplies a direction (a sentence or paragraph stating angle). Studio returns:
- sharpened thesis (one paragraph)
- 3–5 supporting evidence items with source + date (from socialisn Postgres and Perplexity)
- counter-evidence (facts that complicate; never rhetorical)
- one "this angle collapses if…" risk line

User reviews, discusses counter-evidence with the AI chat, refines as needed, then calls the next tool.

**`generate_script(subject, thesis, key_facts, track, duration_min=30)`**
Returns a full Traditional Chinese prose script with this structure:
1. **Hook** (1–2 min) — cold open
2. **Why this matters to the viewer + why this take is different** — teaser logic baked into every script, not bolted on
3. **Context** (3–5 min)
4. **Three key facts with supporting evidence** (15–18 min total)
5. **Counter-evidence acknowledgment + integration** (3–5 min)
6. **Close + track-appropriate CTA**:
   - YouTube: preview/conversion call for members-exclusive content
   - Podcast: arouse curiosity for further deep-dive members content

User internalizes the script and presents it in their own manner.

**`search_discourse(query, window_hours=72, sources[])`**
Ad-hoc RAG over socialisn's Railway Postgres (newsletter_items, YouTube, podcasts, RSS, perplexity_searches). For in-chat follow-ups like *"who in HK commentary has said X this week?"*

**`get_cross_source_momentum(topic, window_hours=72)`**
Raw momentum primitive. Returns `{ distinct_sources, distinct_mentions, velocity_per_day, saturation_penalty, score }` so any chat client can probe a custom topic the studio's candidate lists didn't surface.

### Typical morning loop (human rhythm, not enforced by system)

1. User opens preferred AI chat.
2. `list_daily_candidates("youtube")` + `list_daily_candidates("podcast")` + `check_parking_lot()`.
3. User picks one subject per track.
4. For each pick: `build_thesis_brief(subject, "my angle is...")`.
5. Chat-discusses counter-evidence until comfortable.
6. `generate_script(...)`.
7. Records two 30-min pieces (YouTube + podcast).

## Phase 2.2 — Post-production (sketch)

Additional tools on the same MCP server. Shipped after 2.1 is stable.

**`clean_srt(srt)`** — Proofreads Whisper-generated SRT, fixes known Cantonese error patterns using the user's learned glossary. Returns cleaned SRT + diff summary. Proposes candidate glossary additions on every run; user approves them into `whisper_glossary`.

**`extract_gems(cleaned_srt, original_script)`** — Identifies timestamped spontaneous improvements: high emotional resonance, crisp phrasings, unexpected connections the scripted version missed.

**`suggest_titles(cleaned_srt, gems, subject, thesis)`** — Three candidate titles each with predicted CTR/retention profile, then picks the one optimized for CTR × sustained watch time with reasoning.

**`generate_chapters(cleaned_srt)`** — YouTube Chapters with timecodes at content/discussion shifts, paste-ready for the YouTube description.

**`write_teaser(cleaned_srt, title, gems)`** — Teaser text ("why this matters" + "how this is different") for YouTube community post, Facebook, Threads.

### Glossary asset

New table `whisper_glossary (term, variants[], correction, notes, added_at)`. Seeded empty; grows through user approval of `clean_srt`'s candidate additions. A learning asset, not a static dictionary.

## Architecture

- **Host**: Railway, new service `apps/socialisn-studio/`. Hono + official MCP TypeScript SDK over Streamable HTTP transport.
- **Auth**: static bearer token (single-user personal system).
- **Domain**: `studio.socialisn.com` behind Cloudflare. Apply the known `hkcitizensmedia.com` runbook — **proxy OFF during Let's Encrypt issuance**, then **Full (strict) SSL** once the cert is live.
- **DB**: existing Railway Postgres, shared with socialisn + `unsubject/frontierwatch2`.
  - **Read**: `newsletter_items`, `item_enrichment`, `news_items`, `youtube_items`, `podcast_items`, `perplexity_searches`, and read-only `frontier_briefings` / `frontier_watches`.
  - **Write**: new tables only — `studio_events`, `studio_candidate_scores`, `whisper_glossary`.
- **Models**: Claude Sonnet 4.6 for thesis briefs + script generation + SRT cleanup; Claude Haiku for classification, candidate scoring, glossary candidate extraction.
- **External APIs**: Perplexity (fresh-web evidence), Google Tasks (read + mark-done), OpenAI embeddings (shared stack with 2nd-brain — for semantic candidate dedup).

### Google Tasks scope

Studio needs OAuth scope `https://www.googleapis.com/auth/tasks` against the "Subjects" list. Write capability is narrow: **mark-done only** when the corresponding episode has been recorded (inferred from a `studio_events` record of `generate_script` followed by session close).

### MCP client coverage

MCP remote (HTTP/SSE) is first-class in Claude's ecosystem and in ChatGPT. Gemini and Perplexity support is less mature. Expect Claude desktop + ChatGPT to work day one; Gemini and Perplexity may need a thin HTTP fallback on the same service (same tools exposed as REST endpoints). Implementation contingency, not a design change.

## Telemetry + cross-project journaling

Every studio interaction emits two parallel streams.

### 1. Structured usage log — `studio_events` table

Captures: `event_id`, `session_id`, `user_id`, `tool_name`, `args_json`, `response_summary`, `timestamp`, `ai_client` (Claude / Gemini / ChatGPT / Perplexity, if detectable via user-agent).

Session inference: a session starts on first `list_daily_candidates` call and ends on `generate_script` completion or 4h inactivity.

Derived per-session state: which candidates were *shown*, which was *picked* (inferred from the follow-up `build_thesis_brief` subject), thesis evolution, final script hash.

### 2. Human-readable journal entry → `unsubject/2nd-brain`

On session close, Claude Haiku generates a narrative rollup and sends it to 2nd-brain as a journal entry. 2nd-brain exposes multiple ingestion paths; studio targets the `handleMessage(IncomingMessage)` capture contract (see `unsubject/2nd-brain:src/capture.ts`) with `channel: "socialisn-studio"`. The 10-minute stitching window in `capture.ts` is ignored — studio posts one finalized entry per session. OpenAI embeddings are generated downstream by 2nd-brain's existing pipeline, making every session semantically searchable alongside other journal entries.

Each journal entry includes: date, track, shortlist-vs-pick-vs-rejected, thesis evolution, counter-evidence resolution, final subject.

### Candidate-scoring memory loop

`studio_events` + derived pick/reject signals feed back into `list_daily_candidates` scoring:

- Subjects *picked* lift the audience-fit weights for their topic cluster.
- Subjects *rejected* despite high momentum lower those weights — teaching the scorer what "trend, but not for me" looks like.
- Schema leaves room for a future signal: YouTube Analytics + member retention data closing the performance loop. Out of scope for 2.1 ship.

## Build order (Phase 2.1)

1. MCP server scaffolding at `apps/socialisn-studio/`. Bearer auth. `/healthz`. Cloudflare DNS + cert runbook.
2. Primitives: `search_discourse`, `get_cross_source_momentum`.
3. Candidate engine: `list_daily_candidates` — composes primitives, applies audience-fit weights, enforces track-distinction.
4. Google Tasks wiring: `check_parking_lot` (read) + mark-done (write).
5. `build_thesis_brief` — DB + Perplexity orchestration, counter-evidence discipline.
6. `generate_script` — prompt template, no-fluff + teaser-baked-in constraints, 30-min calibration.
7. Telemetry: `studio_events` writes + 2nd-brain journaling via `capture.ts` ingestion.
8. End-to-end dogfood from Claude desktop, then ChatGPT.

## Build order (Phase 2.2)

Shipped after 2.1 is stable. `clean_srt` first (creates the glossary asset), then `extract_gems`, `suggest_titles`, `generate_chapters`, `write_teaser`.

## Relationship to existing socialisn

- **Read-only** from all existing socialisn ingest tables. The `n8n/workflows/*.ts` pipelines keep filling them; studio consumes.
- **Read-only** from `frontier_*` (owned by `unsubject/frontierwatch2`).
- **Write-only** into new tables (`studio_events`, `studio_candidate_scores`, `whisper_glossary`) and into one external list (Google Tasks "Subjects", mark-done only).
- No changes to n8n workflows are required for phase 2.1.

## Open items (resolve at implementation)

1. **2nd-brain HTTP ingest** — `capture.ts`'s `handleMessage` is the contract, but verify whether it's exposed via an HTTP route in `src/index.ts`. If not, add a small `POST /capture` endpoint in 2nd-brain as a tiny follow-up in that repo.
2. **Google OAuth** — extend the existing `Gmail account` credential with the Tasks scope, or register a new Google credential. Decide during Google Tasks wiring step.
3. **Script length calibration** — 30 min ≈ 4,500–6,000 Traditional Chinese characters. Tune against the user's first few recorded outputs.
4. **AI-client detection** — whether MCP transport headers reliably expose the client identity for the `studio_events.ai_client` field. If not, drop the column.
