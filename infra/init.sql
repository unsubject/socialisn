-- n8n gets its own schema (configured via DB_POSTGRESDB_SCHEMA)
CREATE SCHEMA IF NOT EXISTS n8n;

-- Application tables live in the public schema
-- ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS youtube_items (
    video_id          TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,
    channel_name      TEXT NOT NULL,
    channel_tags      TEXT[] DEFAULT '{}',
    title             TEXT NOT NULL,
    description       TEXT,
    published_at      TIMESTAMPTZ,
    duration_seconds  INTEGER,
    view_count        INTEGER DEFAULT 0,
    like_count        INTEGER DEFAULT 0,
    comment_count     INTEGER DEFAULT 0,
    thumbnail_url     TEXT,
    transcript_text   TEXT,
    transcript_lang   TEXT,
    transcript_source TEXT,
    tags              TEXT[] DEFAULT '{}',
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_items (
    article_id   TEXT PRIMARY KEY,
    source_name  TEXT NOT NULL,
    source_type  TEXT NOT NULL DEFAULT 'rss',
    url          TEXT UNIQUE,
    headline     TEXT NOT NULL,
    excerpt      TEXT,
    full_text    TEXT,
    language     TEXT DEFAULT 'zh-TW',
    tags         TEXT[] DEFAULT '{}',
    published_at TIMESTAMPTZ,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS podcast_items (
    episode_id     TEXT PRIMARY KEY,
    podcast_name   TEXT NOT NULL,
    podcast_tags   TEXT[] DEFAULT '{}',
    title          TEXT NOT NULL,
    description    TEXT,
    episode_url    TEXT,
    duration_seconds INTEGER,
    season         INTEGER,
    episode_number INTEGER,
    published_at   TIMESTAMPTZ,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS newsletter_items (
    message_id    TEXT PRIMARY KEY,
    thread_id     TEXT,
    sender_email  TEXT NOT NULL,
    sender_name   TEXT,
    subject       TEXT NOT NULL,
    body_text     TEXT,
    body_html     TEXT,
    summary       TEXT,
    labels        TEXT[] DEFAULT '{}',
    received_at   TIMESTAMPTZ,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE newsletter_items ADD COLUMN IF NOT EXISTS summary TEXT;

CREATE TABLE IF NOT EXISTS item_enrichment (
    item_type    TEXT NOT NULL,  -- 'youtube', 'news', 'podcast', 'newsletter'
    item_id      TEXT NOT NULL,
    summary_zh   TEXT,
    keywords_zh  TEXT[] DEFAULT '{}',
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_type, item_id)
);

CREATE TABLE IF NOT EXISTS briefings (
    id            SERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    slot          TEXT NOT NULL
                  CONSTRAINT briefings_slot_check
                  CHECK (slot IN ('morning', 'midday', 'evening')),
    markdown      TEXT NOT NULL,
    html          TEXT,
    prompt_tokens INTEGER,
    output_tokens INTEGER,
    email_sent_at TIMESTAMPTZ,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, slot)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_youtube_fetched ON youtube_items (fetched_at);
CREATE INDEX IF NOT EXISTS idx_youtube_published ON youtube_items (published_at);
CREATE INDEX IF NOT EXISTS idx_news_fetched ON news_items (fetched_at);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_items (published_at);
CREATE INDEX IF NOT EXISTS idx_podcast_fetched ON podcast_items (fetched_at);
CREATE INDEX IF NOT EXISTS idx_podcast_published ON podcast_items (published_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_fetched ON newsletter_items (fetched_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_received ON newsletter_items (received_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_sender ON newsletter_items (sender_email);
CREATE INDEX IF NOT EXISTS idx_enrichment_type ON item_enrichment (item_type);
CREATE INDEX IF NOT EXISTS idx_briefings_date ON briefings (date);
