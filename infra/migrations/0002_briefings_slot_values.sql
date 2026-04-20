-- 0002_briefings_slot_values.sql
-- Briefing v2 introduces three ET slots: morning, midday, evening.
-- The original init.sql declared briefings.slot as unconstrained TEXT
-- with only a comment noting the allowed values. This migration adds
-- an explicit CHECK so v2 writers cannot drift.
--
-- Existing rows with slot='morning' or 'evening' remain valid.
-- Rerun-safe via DROP CONSTRAINT IF EXISTS.

ALTER TABLE briefings DROP CONSTRAINT IF EXISTS briefings_slot_check;

ALTER TABLE briefings ADD CONSTRAINT briefings_slot_check
    CHECK (slot IN ('morning', 'midday', 'evening'));
