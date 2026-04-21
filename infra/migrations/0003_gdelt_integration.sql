-- 0003_gdelt_integration.sql
-- GDELT 2.0 DOC API integration (phase A).
--
-- Adds source_subtype column to news_items so a single source_type='gdelt'
-- fans out across multiple named lanes. Creates gdelt_signal for the daily
-- tone + volume aggregates consumed by briefing prompts (phase B workflow).
-- Seeds the four lane configs into the sources table.
--
-- Lanes:
--   hk-core                  ─ HK-local stories (EN + ZH)
--   hk-diaspora-rights       ─ HK-specific rights/transnational coverage in host-country press
--   hk-diaspora-hostcountry  ─ broader host-country policy pulse that middle-class diaspora track:
--                              cost of living, housing, rates, tax, immigration, education, crime, jobs
--   china-economy            ─ HK-lens China markets + policy
--
-- Idempotent via IF NOT EXISTS / ON CONFLICT. Safe to re-run.

-- ── news_items: lane tag ────────────────────────────────────
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS source_subtype TEXT;

-- Briefings filter by (source_type, fetched_at) with an optional subtype
-- narrow. Covering index keeps that path fast once GDELT volume ramps.
CREATE INDEX IF NOT EXISTS idx_news_subtype_fetched
    ON news_items (source_type, source_subtype, fetched_at);

-- ── gdelt_signal: daily aggregates per lane ─────────────────────
CREATE TABLE IF NOT EXISTS gdelt_signal (
    day                   DATE NOT NULL,
    lane                  TEXT NOT NULL,
    articles              INTEGER NOT NULL DEFAULT 0,
    avg_tone              NUMERIC(5,2),
    top_source_countries  JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_langs             JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_themes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, lane)
);

CREATE INDEX IF NOT EXISTS idx_gdelt_signal_lane_day
    ON gdelt_signal (lane, day DESC);

-- ── Retire superseded lane if this migration ran in an earlier draft ─────
DELETE FROM sources WHERE type = 'gdelt' AND name = 'GDELT · HK Diaspora Policy';

-- ── Seed gdelt lane sources ──────────────────────────────────
INSERT INTO sources (type, name, language, tags, priority, config) VALUES
  ('gdelt', 'GDELT · HK Core',                   'en',
    ARRAY['hongkong','gdelt'],
    'normal',
    '{"subtype":"hk-core","query":"(\"hong kong\" OR 香港) -\"hong kong disneyland\" (sourcelang:english OR sourcelang:chinese)"}'::jsonb),

  ('gdelt', 'GDELT · HK Diaspora Rights',        'en',
    ARRAY['hongkong','diaspora','rights','gdelt'],
    'normal',
    '{"subtype":"hk-diaspora-rights","query":"(BNO OR \"hong kong pathway\" OR \"safe haven\" OR \"transnational repression\" OR \"hong kong 47\" OR \"jimmy lai\" OR \"hong kong activist\" OR \"overseas dissident\" OR \"hong kong consulate\") (sourcecountry:UK OR sourcecountry:CA OR sourcecountry:AS OR sourcecountry:TW OR sourcecountry:US)"}'::jsonb),

  ('gdelt', 'GDELT · HK Diaspora Host-Country',  'en',
    ARRAY['hongkong','diaspora','hostcountry','gdelt'],
    'normal',
    '{"subtype":"hk-diaspora-hostcountry","query":"(theme:ECON_COST_OF_LIVING OR theme:ECON_HOUSING_PRICES OR theme:ECON_INFLATION OR theme:ECON_INTEREST_RATES OR theme:TAX_FNCACT_TAXPAYER OR theme:IMMIGRATION OR theme:EDUCATION OR theme:CRIME_VIOLENCE OR theme:JOBS OR theme:EPU_POLICY) (sourcecountry:UK OR sourcecountry:CA OR sourcecountry:AS OR sourcecountry:US OR sourcecountry:TW)"}'::jsonb),

  ('gdelt', 'GDELT · China Economy (HK lens)',   'en',
    ARRAY['china','hongkong','economics','gdelt'],
    'normal',
    '{"subtype":"china-economy","query":"(\"hang seng\" OR HSI OR \"southbound connect\" OR \"country garden\" OR evergrande OR yuan OR PBoC OR HKD OR \"hong kong dollar\") (theme:ECON_STOCKMARKET OR theme:ECON_BANKRUPTCY OR theme:ECON_HOUSING_PRICES)"}'::jsonb)
ON CONFLICT (type, name) DO UPDATE SET
  language = EXCLUDED.language,
  tags     = EXCLUDED.tags,
  priority = EXCLUDED.priority,
  config   = EXCLUDED.config,
  updated_at = NOW();
