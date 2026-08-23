-- ============================================================
-- SWACHHAM — GST verification flag + constitution on businesses
-- Migration: 024_business_gst_verified_flag.sql
--
-- Completes the GST columns added by 023. The table already has
-- gst_number, legal_name, trade_name, gst_status, gst_registered_on,
-- gst_verified_at, state and pincode, so only two are added here:
--
--   gst_verified       -- did this row pass a real provider lookup?
--   gst_business_type  -- `ctb`, the constitution of business
--
-- gst_verified is written by the server only, from the result of its
-- own lookup; a value sent by a client is never read.
--
-- Additive and idempotent: both columns are NULLable/defaulted, no
-- existing column is renamed or dropped, and no row is deleted.
-- ============================================================

SET @has_gst_verified = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'gst_verified'
);
SET @sql = IF(@has_gst_verified = 0,
  'ALTER TABLE businesses ADD COLUMN gst_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER gst_number',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_gst_business_type = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'businesses'
     AND COLUMN_NAME  = 'gst_business_type'
);
SET @sql = IF(@has_gst_business_type = 0,
  'ALTER TABLE businesses ADD COLUMN gst_business_type VARCHAR(120) NULL AFTER gst_status',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Rows onboarded before this column existed but which DID pass a lookup
-- are marked verified, so the flag agrees with gst_verified_at rather
-- than reading as "unverified" for every historical row.
UPDATE businesses
   SET gst_verified = 1
 WHERE gst_verified = 0
   AND gst_verified_at IS NOT NULL;
