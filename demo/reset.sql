-- Reset the demo database to its seeded state. Idempotent — safe to run again.
--
-- The public demo logs in as a read-only `demo` role, so visitors can't change
-- anything; this mainly exists to undo your OWN admin edits, or as belt-and-
-- suspenders. To run it on a schedule, either:
--   • Supabase pg_cron:  SELECT cron.schedule('reset-demo','0 * * * *',
--                          $$ ... paste this file's statements ... $$);
--   • or an hourly GitHub Action / cron that runs:  psql "$DB" -f demo/reset.sql
--
-- Run from the demo/ directory so the \i include resolves:
--   psql "$STEWARD_DB" -v ON_ERROR_STOP=1 -f reset.sql
DROP TABLE IF EXISTS order_items, orders, subscriptions, products, customers CASCADE;
\i seed.sql
