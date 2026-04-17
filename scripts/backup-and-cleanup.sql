-- Savely API Database Cleanup
-- Run this against the savely-api Supabase instance (jqwavlrtsztogddumxzv, us-west-2)
--
-- KEEP (admin rebuild will use these):
--   - brand_domain_reviews (domain approval queue, 402 rows)
--   - brand_domain_candidates (candidate domains, 2131 rows)
--
-- All tables below have been backed up to:
--   /Users/jamesb/Documents/savely-backups/2026-04-17/

-- Step 1: Drop the view that depends on brand_daily_viewers
DROP VIEW IF EXISTS v_brand_daily_viewers CASCADE;

-- Step 2: Drop analytics tables (replaced by Axiom)
DROP TABLE IF EXISTS extension_events CASCADE;
DROP TABLE IF EXISTS brand_daily_viewers CASCADE;
DROP TABLE IF EXISTS user_feedback CASCADE;

-- Step 3: Drop audit-only table (not read by any app)
DROP TABLE IF EXISTS brand_classifications CASCADE;

-- Step 4: Drop never-populated or legacy tables
DROP TABLE IF EXISTS provider_brand_listings CASCADE;
DROP TABLE IF EXISTS brand_domain_failures CASCADE;
DROP TABLE IF EXISTS brand_events CASCADE;
