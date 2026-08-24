-- ============================================================
-- SWACHHAM — Where a rider COLLECTS from
-- Migration: 039_rider_job_origin.sql
--
-- A delivery has TWO locations and the job could only hold one.
--
-- For a pickup that was fine: the rider comes from wherever they
-- happen to be, and the only place that matters is the customer's
-- door. A delivery is not like that. The rider must first go to the
-- FACILITY to load the finished laundry, and only then to the
-- customer. Matching a delivery to "the rider nearest the customer"
-- sends the job to whoever is closest to a door they cannot usefully
-- visit yet — the right question is who is nearest the FACILITY.
--
-- So a job now carries an origin as well as a destination:
--
--   PICKUP    origin NULL, destination = the customer or establishment
--             (matched on the destination: that is where the rider is
--             being sent, and they start from wherever they are)
--
--   DELIVERY  origin = the facility, destination = the customer
--             (matched on the ORIGIN, because collecting comes first)
--
-- The facility's coordinates are configuration, not a row here: see
-- FACILITY_LATITUDE / FACILITY_LONGITUDE in the backend env. They are
-- snapshotted onto each job at creation, like the address is, so a
-- facility that moves does not rewrite journeys already made.
--
-- Idempotent: every step is gated on information_schema. MySQL only.
-- ============================================================

-- ---- rider_jobs.origin_latitude ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND COLUMN_NAME = 'origin_latitude');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN origin_latitude DECIMAL(10,7) NULL AFTER longitude',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- rider_jobs.origin_longitude ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND COLUMN_NAME = 'origin_longitude');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN origin_longitude DECIMAL(10,7) NULL AFTER origin_latitude',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- rider_jobs.origin_address ----
-- What the rider reads on the card, and what Google geocodes when the
-- coordinates are missing.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND COLUMN_NAME = 'origin_address');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN origin_address VARCHAR(500) NULL AFTER origin_longitude',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- rider_jobs.collected_from_origin_at ----
-- When the rider loaded at the facility. Distinct from `collected_at`,
-- which for a delivery is the moment the CUSTOMER took it.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rider_jobs'
    AND COLUMN_NAME = 'loaded_at');
SET @sql = IF(@x = 0,
  'ALTER TABLE rider_jobs ADD COLUMN loaded_at DATETIME NULL AFTER en_route_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
