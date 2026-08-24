-- ============================================================
-- SWACHHAM — Remove the rider capacity fields
-- Migration: 038_drop_rider_capacity.sql
--
-- 037 added a weight ceiling per rider and a per-job weight snapshot,
-- so dispatch could tell a rider whether a second order would fit.
-- That was a misreading: weight was the EXAMPLE of why a loaded rider
-- might not want another pickup, not a rule anyone asked to enforce.
-- The thing actually wanted is simply that an order a rider cannot take
-- right now stays reserved instead of being lost — which is the HELD
-- status, and that stays.
--
-- So the two capacity columns go. Nothing outside the rider module ever
-- read them, and they carried no data worth keeping: `max_load_kg` was
-- a default nobody had tuned, and `load_kg` was a copy of
-- `orders.total_weight_kg`, which is still there and still readable by
-- anything that wants to show a weight.
--
-- WHAT IS DELIBERATELY KEPT:
--   HELD / held_at / held_by      the reserve-until-accepted behaviour
--   COLLECTED / collected_at      "the rider has picked up the order"
--                                 and is carrying it to the facility —
--                                 the state the whole question was
--                                 asked about
--
-- Idempotent: every step is gated on information_schema. MySQL only.
-- ============================================================


-- ---- The index over the capacity columns must go first ----
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND INDEX_NAME = 'idx_rider_job_load');
SET @sql = IF(@x > 0,
  'ALTER TABLE rider_jobs DROP INDEX idx_rider_job_load',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A plain (rider_id, status) index still serves "what is this rider on".
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND INDEX_NAME = 'idx_rider_job_rider');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD INDEX idx_rider_job_rider (rider_id, status)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ---- rider_jobs.load_kg ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs' AND COLUMN_NAME = 'load_kg');
SET @sql = IF(@x > 0,
  'ALTER TABLE rider_jobs DROP COLUMN load_kg',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ---- rider_profiles.max_load_kg ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_profiles' AND COLUMN_NAME = 'max_load_kg');
SET @sql = IF(@x > 0,
  'ALTER TABLE rider_profiles DROP COLUMN max_load_kg',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
