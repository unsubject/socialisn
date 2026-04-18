-- Seed data for the `sources` table
-- Migrates config/channels.yaml, config/news_sources.yaml, and config/podcasts.yaml
-- into a single Postgres table that fetcher workflows query at runtime.
--
-- Run this AFTER infra/init.sql has created the base tables.
-- Safe to re-run: uses ON CONFLICT to update existing rows.

CREATE TABLE IF NOT EXISTS sources (
    id          SERIAL PRIMARY KEY,
    type        TEXT NOT NULL,           -- 'youtube' | 'rss' | 'podcast' | 'scrape'
    name        TEXT NOT NULL,
    language    TEXT,
    tags        TEXT[] DEFAULT '{}',
    priority    TEXT DEFAULT 'normal',
    enabled     BOOLEAN DEFAULT TRUE,
    config      JSONB DEFAULT '{}'::jsonb,  -- type-specific: {channel_id} or {url} or {apple_id}
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (type, name)
);

CREATE INDEX IF NOT EXISTS idx_sources_type_enabled ON sources (type, enabled);

-- ---------------------------------------------------------------------------
-- YouTube channels (from config/channels.yaml)
-- ---------------------------------------------------------------------------

INSERT INTO sources (type, name, language, tags, config) VALUES
  ('youtube', 'CC News 新聞.政評',                'zh', ARRAY['taiwan','hongkong'],            '{"channel_id":"UCVZTkv6LM-_xWUM9t-jS5JA"}'::jsonb),
  ('youtube', 'Hong Kong Uncensored 香港冇格仔',  'zh', ARRAY['uk','hongkong'],                '{"channel_id":"UCm4NHRafzs1BtpjWiop8vmQ"}'::jsonb),
  ('youtube', '風雲谷 Whirling Clouds Valley',    'zh', ARRAY['uk','hongkong'],                '{"channel_id":"UCCVFgDdTfiGxQ695BxMBMUg"}'::jsonb),
  ('youtube', '財經拆局',                         'zh', ARRAY['uk','finance','hongkong'],      '{"channel_id":"UCwkVGGhBqOY7DSybymuvX5w"}'::jsonb),
  ('youtube', '《謎米香港》',                     'zh', ARRAY['taiwan','hongkong'],            '{"channel_id":"UCu_YquoQYKR3GpP82TO-zRw"}'::jsonb),
  ('youtube', '綠豆',                             'zh', ARRAY['news','hongkong'],              '{"channel_id":"UCLYWo70xBDrPYJgJsxoX7Qg"}'::jsonb),
  ('youtube', '白兵',                             'zh', ARRAY['hongkong'],                     '{"channel_id":"UCXKg0qPRz32bs5Z4mTGF3TQ"}'::jsonb),
  ('youtube', '潘東海',                           'zh', ARRAY['politics','hongkong'],          '{"channel_id":"UCEM2q4LVoDKAdtLnl2r9zuw"}'::jsonb),
  ('youtube', '潘卓鴻',                           'zh', ARRAY['hongkong'],                     '{"channel_id":"UC26-Wfy43LySUS7bp3SQzaQ"}'::jsonb),
  ('youtube', '渾水',                             'zh', ARRAY['hongkong'],                     '{"channel_id":"UCdgBHGdr74w-E6rRd6luaeQ"}'::jsonb),
  ('youtube', '沈旭暉',                           'zh', ARRAY['taiwan','hongkong'],            '{"channel_id":"UCcECXkak8MWeYGwHWg6gVow"}'::jsonb),
  ('youtube', '桑普頻道',                         'zh', ARRAY['hongkong','taiwan','china'],    '{"channel_id":"UCC5ph0Dx4HcIp4ZH06extyA"}'::jsonb),
  ('youtube', '文昭',                             'zh', ARRAY['china','history'],              '{"channel_id":"UCtAIPjABiQD3qjlEl1T5VpA"}'::jsonb),
  ('youtube', '政經孫老師',                       'zh', ARRAY['china','finance'],              '{"channel_id":"UC1Lk6WO-eKuYc6GHYbKVY2g"}'::jsonb),
  ('youtube', '曾志豪',                           'zh', ARRAY['uk','hongkong'],                '{"channel_id":"UCh_KRmXM4RiQFvOBBDpvC6Q"}'::jsonb),
  ('youtube', '徐少驊',                           'zh', ARRAY['uk','hongkong'],                '{"channel_id":"UC5q0HLxSC8SJE9O7Gw3YYWg"}'::jsonb),
  ('youtube', '堅離地球',                         'zh', ARRAY['taiwan','hongkong'],            '{"channel_id":"UCXf8jlTSP9kp6g4ROCfgvbQ"}'::jsonb),
  ('youtube', '傑斯',                             'zh', ARRAY['canada','hongkong'],            '{"channel_id":"UCYQPuQNS2b9yqsNGI8YHhzQ"}'::jsonb),
  ('youtube', '于飛',                             'zh', ARRAY['taiwan','hongkong'],            '{"channel_id":"UCeL3tSUiG935mm2I5Thpigg"}'::jsonb),
  ('youtube', '城寨',                             'zh', ARRAY['canada','hongkong'],            '{"channel_id":"UC0zUmHNpkviI6UZ0uqCYrww"}'::jsonb),
  ('youtube', '吳志森',                           'zh', ARRAY['uk','hongkong'],                '{"channel_id":"UCAF3AZZj6urHbv4X9iGrFBQ"}'::jsonb)
ON CONFLICT (type, name) DO UPDATE SET
  language = EXCLUDED.language,
  tags     = EXCLUDED.tags,
  config   = EXCLUDED.config,
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- News RSS feeds (from config/news_sources.yaml)
-- ---------------------------------------------------------------------------

INSERT INTO sources (type, name, language, tags, priority, config) VALUES
  ('rss', 'Newsletter Digest',              'zh-TW', ARRAY['simon','newsletter'],                            'normal', '{"url":"https://unsubject.github.io/newsletter-digest/feed"}'::jsonb),
  ('rss', 'Google Trends 香港熱搜',          'zh-TW', ARRAY['hongkong','trending','social-signal','chinese'],'normal', '{"url":"https://trends.google.com/trending/rss?geo=HK"}'::jsonb),
  ('rss', 'South China Morning Post',       'en',    ARRAY['hongkong','english','general'],                  'normal', '{"url":"https://www.scmp.com/rss/92/feed"}'::jsonb),
  ('rss', 'CNBC Asia Economy',              'en',    ARRAY['global','economics','english'],                  'normal', '{"url":"https://www.cnbc.com/id/100727362/device/rss/rss.html"}'::jsonb),
  ('rss', 'RTHK 財經新聞',                   'zh-TW', ARRAY['hongkong','economics','chinese'],                'normal', '{"url":"https://rthk.hk/rthk/news/rss/c_expressnews_cfinance.xml"}'::jsonb),
  ('rss', 'RTHK 本地新聞',                   'zh-TW', ARRAY['hongkong','politics','chinese'],                 'normal', '{"url":"https://rthk.hk/rthk/news/rss/c_expressnews_clocal.xml"}'::jsonb),
  ('rss', 'RTHK 兩岸新聞',                   'zh-TW', ARRAY['china','taiwan','chinese'],                      'normal', '{"url":"https://rthk.hk/rthk/news/rss/c_expressnews_greaterchina.xml"}'::jsonb),
  ('rss', '香港政府新聞網 — 財經',           'zh-TW', ARRAY['hongkong','economics','government','chinese'],   'normal', '{"url":"https://www.news.gov.hk/tc/categories/finance/html/articlelist.rss.xml"}'::jsonb)
ON CONFLICT (type, name) DO UPDATE SET
  language = EXCLUDED.language,
  tags     = EXCLUDED.tags,
  priority = EXCLUDED.priority,
  config   = EXCLUDED.config,
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- Podcasts (from config/podcasts.yaml) — Apple Podcasts numeric IDs
-- ---------------------------------------------------------------------------

INSERT INTO sources (type, name, language, tags, config) VALUES
  ('podcast', 'Unhedged',                       'en', ARRAY['finance','ft'],         '{"apple_id":"1691284824"}'::jsonb),
  ('podcast', 'The Economics Show',             'en', ARRAY['economics','ft'],       '{"apple_id":"1746352576"}'::jsonb),
  ('podcast', 'Behind the Money',               'en', ARRAY['finance','ft'],         '{"apple_id":"1376303362"}'::jsonb),
  ('podcast', 'FT Tech Tonic',                  'en', ARRAY['tech','ft'],            '{"apple_id":"1169101860"}'::jsonb),
  ('podcast', 'Hard Fork',                      'en', ARRAY['tech','nyt'],           '{"apple_id":"1528594034"}'::jsonb),
  ('podcast', 'Big Take',                       'en', ARRAY['finance','bloomberg'],  '{"apple_id":"1578096201"}'::jsonb),
  ('podcast', 'Money Stuff: The Podcast',       'en', ARRAY['finance','bloomberg'],  '{"apple_id":"1739582836"}'::jsonb),
  ('podcast', 'Odd Lots',                       'en', ARRAY['economics','bloomberg'],'{"apple_id":"1056200096"}'::jsonb),
  ('podcast', 'Bloomberg Intelligence',         'en', ARRAY['finance','bloomberg'],  '{"apple_id":"326301337"}'::jsonb),
  ('podcast', 'Wall Street Week',               'en', ARRAY['finance','bloomberg'],  '{"apple_id":"1494307824"}'::jsonb),
  ('podcast', 'The Indicator from Planet Money','en', ARRAY['economics','npr'],      '{"apple_id":"1320118593"}'::jsonb),
  ('podcast', 'Planet Money',                   'en', ARRAY['economics','npr'],      '{"apple_id":"290783428"}'::jsonb)
ON CONFLICT (type, name) DO UPDATE SET
  language = EXCLUDED.language,
  tags     = EXCLUDED.tags,
  config   = EXCLUDED.config,
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- Perplexity Search queries (one row per topic)
-- The fetch-perplexity workflow queries this set; each row produces a summary
-- of recent news on that topic (saved into news_items with source_type='perplexity').
-- ---------------------------------------------------------------------------

INSERT INTO sources (type, name, language, tags, config) VALUES
  ('perplexity', 'HK Economy & Finance (EN)',           'en',    ARRAY['hongkong','economics','finance'],          '{"query":"Hong Kong economy and financial market news today"}'::jsonb),
  ('perplexity', '香港經濟金融 (ZH)',                   'zh-TW', ARRAY['hongkong','economics','finance','chinese'],'{"query":"香港經濟 金融市場 今日新聞"}'::jsonb),
  ('perplexity', 'HK Stock Market & IPO',                'en',    ARRAY['hongkong','finance','stock-market'],       '{"query":"Hong Kong stock market IPO investment news today"}'::jsonb),
  ('perplexity', 'HK Property Market',                   'en',    ARRAY['hongkong','economics','property'],         '{"query":"Hong Kong property market real estate news today"}'::jsonb),
  ('perplexity', 'HKMA Monetary Policy',                 'en',    ARRAY['hongkong','monetary-policy','government'], '{"query":"HKMA monetary policy Hong Kong banking regulation news"}'::jsonb),
  ('perplexity', 'HK Government & Politics (EN)',        'en',    ARRAY['hongkong','politics'],                     '{"query":"Hong Kong government policy political news today"}'::jsonb),
  ('perplexity', '香港政治 (ZH)',                       'zh-TW', ARRAY['hongkong','politics','chinese'],           '{"query":"香港政治 政府政策 今日重要新聞"}'::jsonb),
  ('perplexity', 'HK Top Breaking News',                 'en',    ARRAY['hongkong','general'],                      '{"query":"Hong Kong top breaking news today"}'::jsonb),
  ('perplexity', 'China Economy & Trade (EN)',           'en',    ARRAY['china','economics'],                       '{"query":"China economy GDP trade policy news today"}'::jsonb),
  ('perplexity', '中國經濟政策 (ZH)',                   'zh-TW', ARRAY['china','economics','politics','chinese'],  '{"query":"中國經濟 中央政府政策 今日新聞"}'::jsonb),
  ('perplexity', 'China Government Policy',              'en',    ARRAY['china','politics'],                        '{"query":"China central government political decisions policy news today"}'::jsonb),
  ('perplexity', 'China Finance & Technology',           'en',    ARRAY['china','finance','technology'],            '{"query":"China financial market regulation technology sector news today"}'::jsonb),
  ('perplexity', 'Global Economy & Markets',             'en',    ARRAY['global','economics','finance'],            '{"query":"Global economy world financial market news today"}'::jsonb),
  ('perplexity', 'US Fed & Monetary Policy',             'en',    ARRAY['global','monetary-policy'],                '{"query":"US Federal Reserve interest rate global monetary policy news today"}'::jsonb),
  ('perplexity', 'Global Trade & Geopolitics',           'en',    ARRAY['global','economics','trade'],              '{"query":"Global trade tariffs geopolitics economic impact news today"}'::jsonb),
  ('perplexity', 'UK Economy & Finance',                 'en',    ARRAY['uk','economics','finance'],                '{"query":"UK economy financial market Bank of England news today"}'::jsonb),
  ('perplexity', 'UK Government & Politics',             'en',    ARRAY['uk','politics'],                           '{"query":"UK government Westminster political policy news today"}'::jsonb),
  ('perplexity', 'Canada Economy & Finance',             'en',    ARRAY['canada','economics','finance'],            '{"query":"Canada economy financial market Bank of Canada news today"}'::jsonb),
  ('perplexity', 'Canada Government & Politics',         'en',    ARRAY['canada','politics'],                       '{"query":"Canada federal government Ottawa political policy news today"}'::jsonb)
ON CONFLICT (type, name) DO UPDATE SET
  language = EXCLUDED.language,
  tags     = EXCLUDED.tags,
  config   = EXCLUDED.config,
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- SELECT type, COUNT(*) FROM sources GROUP BY type ORDER BY type;
--   Expected: perplexity=19, podcast=12, rss=8, youtube=21
