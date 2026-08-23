-- ============================================================
-- SWACHHAM — GST verification details on businesses
-- Migration: 023_business_gst_verification.sql
--
-- The businesses table already carries `gst_number`, `name`,
-- `address`, `city`, `state` and `pincode`, so only the fields
-- IRIS returns that had nowhere to live are added here:
--
--   legal_name       -- lgnm, the name on the GST registration
--   trade_name       -- tradeNam, the name the business trades under
--   gst_status       -- sts, e.g. Active / Cancelled / Suspended
--   gst_registered_on-- rgdt, the registration date
--   gst_verified_at  -- when this row last passed verification
--
-- Nothing existing is renamed, widened or dropped, and every
-- column is NULLable so rows created before GST verification
-- existed stay valid exactly as they are.
--
-- Idempotent: each column is gated on its own existence, so the
-- file can be re-run safely.
-- ============================================================

SET @has_legal_name = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'legal_name'
);
SET @sql = IF(@has_legal_name = 0,
  'ALTER TABLE businesses ADD COLUMN legal_name VARCHAR(255) NULL AFTER name',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_trade_name = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'trade_name'
);
SET @sql = IF(@has_trade_name = 0,
  'ALTER TABLE businesses ADD COLUMN trade_name VARCHAR(255) NULL AFTER legal_name',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_gst_status = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'gst_status'
);
SET @sql = IF(@has_gst_status = 0,
  'ALTER TABLE businesses ADD COLUMN gst_status VARCHAR(50) NULL AFTER gst_number',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_gst_regd = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'gst_registered_on'
);
SET @sql = IF(@has_gst_regd = 0,
  'ALTER TABLE businesses ADD COLUMN gst_registered_on VARCHAR(20) NULL AFTER gst_status',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_gst_verified_at = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'gst_verified_at'
);
SET @sql = IF(@has_gst_verified_at = 0,
  'ALTER TABLE businesses ADD COLUMN gst_verified_at DATETIME NULL AFTER gst_registered_on',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- One business per GSTIN. The service already refuses a duplicate with a
-- 409; this makes the database refuse it too, which is what stops two
-- concurrent registrations both passing that check.
--
-- Added only when no unique index on the column exists yet, and only when
-- the data can satisfy it — duplicates are left alone rather than deleted,
-- and the index is simply skipped so the migration never destroys data.
SET @has_gst_unique = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'gst_number'
     AND NON_UNIQUE   = 0
);

SET @dupe_gst = (
  SELECT COUNT(*) FROM (
    SELECT gst_number FROM businesses
     WHERE gst_number IS NOT NULL AND TRIM(gst_number) <> ''
     GROUP BY gst_number HAVING COUNT(*) > 1
  ) d
);

SET @sql = IF(@has_gst_unique = 0 AND @dupe_gst = 0,
  'ALTER TABLE businesses ADD UNIQUE KEY uk_businesses_gst_number (gst_number)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
