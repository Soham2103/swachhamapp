-- ============================================================
-- SWACHHAM — Rider capacity and held jobs
-- Migration: 037_rider_capacity_and_hold.sql
--
-- A rider is not a queue, they are a vehicle with a load on it.
--
-- The first cut of the rider module let a rider accept any number of
-- jobs up to a COUNT (`max_active_jobs`), which is the wrong unit
-- entirely: this database has orders from 3.3 kg to 121 kg, and three
-- jobs might be nine kilos or three hundred. What actually stops a
-- rider taking another pickup is what is already on the bike.
--
-- What this adds:
--
--   COLLECTED       A pickup job's new state between the handover and
--                   the drop at the facility. This is the window where
--                   the rider is CARRYING the load — the whole reason
--                   a second offer needs a different answer — and the
--                   previous model had no state for it at all: a job
--                   went straight from ARRIVED to COMPLETED and the
--                   goods on the bike were invisible.
--
--   HELD            A job the rider has claimed but deferred. "Not
--                   now, I am full — but I want it once I have
--                   unloaded." It is reserved for that rider rather
--                   than returned to the pool, and reclaimed
--                   automatically if it is sat on too long, so an
--                   order can never be lost behind a full bike.
--
--   load_kg         The order's weight, snapshotted onto the job.
--   max_load_kg     What this rider's vehicle can carry.
--
-- Idempotent: every step is gated on information_schema. MySQL only.
-- ============================================================


-- ============================================================
-- 1. rider_jobs: the two new states
-- ============================================================
--
-- APPENDED to whatever the column already lists, read live from
-- information_schema, for the same reason the role enums are extended
-- this way — spelling the enum out by hand would drop any value this
-- database has that the migration files do not know about.
SET @curr = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs' AND COLUMN_NAME = 'status');
SET @sql = IF(@curr IS NOT NULL AND @curr NOT LIKE '%COLLECTED%',
  CONCAT('ALTER TABLE rider_jobs MODIFY COLUMN status ',
         LEFT(@curr, CHAR_LENGTH(@curr) - 1),
         ',''COLLECTED'',''HELD'') NOT NULL DEFAULT ''PENDING'''),
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 2. rider_jobs.load_kg — the weight this job puts on the bike
-- ============================================================
--
-- Snapshotted from `orders.total_weight_kg` when the job is created,
-- for the same reason the address is snapshotted: an order re-weighed
-- at the facility must not retroactively change what the rider was
-- told they were collecting.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs' AND COLUMN_NAME = 'load_kg');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN load_kg DECIMAL(12,3) NOT NULL DEFAULT 0 AFTER job_type',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- When the handover happened, as distinct from when the load reached
-- the facility. `completed_at` now means "off the bike".
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs' AND COLUMN_NAME = 'collected_at');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN collected_at DATETIME NULL AFTER arrived_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- When the rider put it on hold. Drives the reclaim sweep.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs' AND COLUMN_NAME = 'held_at');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN held_at DATETIME NULL AFTER collected_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The rider holding it, kept when `rider_id` is cleared on reclaim so
-- the same rider is not immediately offered it back.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs' AND COLUMN_NAME = 'held_by');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN held_by BIGINT UNSIGNED NULL AFTER held_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 3. rider_profiles.max_load_kg — what the vehicle can carry
-- ============================================================
--
-- 30 kg is a loaded two-wheeler with laundry bags; a van is set higher
-- per rider. It is a DEFAULT and not a hard gate: the server reports
-- what will and will not fit and lets the rider decide, because a
-- refusal computed from a number would strand the 121 kg orders this
-- database actually contains.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_profiles' AND COLUMN_NAME = 'max_load_kg');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_profiles ADD COLUMN max_load_kg DECIMAL(8,3) NOT NULL DEFAULT 30 AFTER max_active_jobs',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 4. rider_job_offers: HELD as an answer
-- ============================================================
--
-- Alongside ACCEPTED and DECLINED, so the offer record still says what
-- the rider actually replied. "I am full right now" is a different
-- answer from "not interested", and dispatch treats them differently:
-- a decline takes the rider out of the running, a hold does not.
SET @curr = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_job_offers' AND COLUMN_NAME = 'status');
SET @sql = IF(@curr IS NOT NULL AND @curr NOT LIKE '%HELD%',
  CONCAT('ALTER TABLE rider_job_offers MODIFY COLUMN status ',
         LEFT(@curr, CHAR_LENGTH(@curr) - 1),
         ',''HELD'') NOT NULL DEFAULT ''OFFERED'''),
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 5. Backfill load_kg for jobs created before this migration
-- ============================================================
UPDATE rider_jobs rj
   JOIN orders o ON o.id = rj.order_id
    SET rj.load_kg = COALESCE(o.total_weight_kg, 0)
  WHERE rj.load_kg = 0;


-- ============================================================
-- 6. Index for the carrying-load query
-- ============================================================
-- "What is this rider carrying" runs on every offer and every
-- dashboard read, and it filters on rider plus status.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND INDEX_NAME = 'idx_rider_job_load');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD INDEX idx_rider_job_load (rider_id, status, load_kg)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
