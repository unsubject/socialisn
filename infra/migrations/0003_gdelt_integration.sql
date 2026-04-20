-- 0003_gdelt_integration.sql
-- GDELT 2.0 DOC API integration (phase A).
--
-- Adds source_subtype column to news_items so a single source_type='gdelt'
-- fans out across multiple named lanes (hk-core, hk-diaspora-policy,
-- china-economy). Creates gdelt_signal for the daily tone + volume
-- aggregates consumed by briefing prompts (phase B workflow). Seeds the
-- three lane configs into the sources table.
--
-- Idempotent via IF NOT EXISTS / ON CONFLICT. Safe to re-run.

-- ── news_items: lane tag ────────────────────────────────────────────
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS source_subtype TEXT;

-- Briefings filter by (source_type, fetched_at) with an optional subtype
-- narrow. Covering index keeps that path fast once GDELT volume ramps.
CREATE INDEX IF NOT EXISTS idx_news_subtype_fetched
    ON news_items (source_type, source_subtype, fetched_at);

-- ── gdelt_signal: daily aggregates per lane ─────────────────────────
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

-- ── Seed gdelt lane sources ────────────────────────────────────────
-- Each row drives one lane of the fetch-gdelt-articles workflow.
-- config.query    ── GDELT DOC 2.0 query string (edit in place to tune).
-- config.subtype  ── copied into news_items.source_subtype for join tagging.

INSERT INTO sources (type, name, language, tags, priority, config) VALUES
  ('gdelt', 'GDELT · HK Core',                 'en',
    ARRAY['hongkong','gdelt'],
    'normal',
    '{"subtype":"hk-core","query":"(\"hong kong\" OR 香港) -\"hong kong disneyland\" (sourcelang:english OR sourcelang:chinese)"}'::jsonb),
  ('gdelt', 'GDELT · HK Diaspora Policy',      'en',
    ARRAY['hongkong','diaspora','gdelt'],
    'normal',
    '{"subtype":"hk-diaspora-policy","query":"(BNO OR \"hong kong pathway\" OR \"safe haven\" OR \"transnational repression\" OR \"hong kong 47\" OR \"jimmy lai\") (sourcecountry:UK OR sourcecountry:CA OR sourcecountry:AS OR sourcecountry:TW OR sourcecountry:US)"}'::jsonb),
  ('gdelt', 'GDELT · China Economy (HK lens)', 'en',
    ARRAY['china','hongkong','economics','gdelt'],
    'normal',
    '{"subtype":"china-economy","query":"(\"hang seng\" OR HSI OR \"southbound connect\" OR \"country garden\" OR evergrande OR yuan OR PBoC OR HKD OR \"hong kong dollar\") (theme:ECON_STOCKMARKET OR theme:ECON_BANKRUPTCY OR theme:ECON_HOUSING_PRICES)"}'::jsonb)
ON CONFLICT (type, name) DO UPDATE SET
  language = EXCLUDED.language,
  tags     = EXCLUDED.tags,
  priority = EXCLUDED.priority,
  config   = EXCLUDED.config,
  updated_at = NOW();

-- ── Verification ────────────────────────────────────────────────────
-- SELECT type, name, config->>'subtype' AS lane FROM sources WHERE type = 'gdelt';
-- SELECT source_subtype, COUNT(*) FROM news_items WHERE source_type = 'gdelt' GROUP BY 1;
-- SELECT * FROM gdelt_signal ORDER BY day DESC, lane LIMIT 20;
