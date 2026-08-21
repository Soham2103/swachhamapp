-- ============================================================
-- SWACHHAM — Super admin portal
-- Migration: 020_super_admin_portal.sql
--
-- Three additive changes behind the super admin dashboard:
--
--   1. RIDER role on users. Riders are plain `users` rows — no
--      separate table — so they reuse the same auth, the same
--      mobile-number uniqueness and the same OTP machinery.
--
--   2. PENDING on businesses.status, so a new business signup
--      waits for approval instead of going live immediately.
--
--   3. users.approval_status, the rider equivalent of the
--      businesses.status gate. NULL for every role that does not
--      need approving (CUSTOMER, ADMIN, SUPER_ADMIN, SORTER), so
--      no existing row changes meaning.
--
-- Every step is additive: extending an ENUM with new values and
-- adding a nullable column rewrite no rows and invalidate no
-- existing value.
--
-- Idempotent: gated on information_schema. MySQL only.
-- ============================================================

-- ---- 1. RIDER role ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%RIDER%');
SET @sql = IF(@x = 0,
  'ALTER TABLE users MODIFY COLUMN role ENUM(''CUSTOMER'',''BUSINESS'',''ADMIN'',''SUPER_ADMIN'',''SORTER'',''RIDER'') NOT NULL DEFAULT ''CUSTOMER''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 2. PENDING business status ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%PENDING%');
SET @sql = IF(@x = 0,
  'ALTER TABLE businesses MODIFY COLUMN status ENUM(''PENDING'',''ACTIVE'',''INACTIVE'',''REJECTED'') NOT NULL DEFAULT ''PENDING''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Businesses that already existed were live before approval was a
-- concept; they stay ACTIVE. Only signups from here on wait.

-- ---- 3. Rider approval gate ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'approval_status');
SET @sql = IF(@x = 0,
  'ALTER TABLE users ADD COLUMN approval_status ENUM(''PENDING'',''APPROVED'',''REJECTED'') NULL DEFAULT NULL AFTER is_active',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'approval_note');
SET @sql = IF(@x = 0,
  'ALTER TABLE users ADD COLUMN approval_note VARCHAR(300) NULL DEFAULT NULL AFTER approval_status',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Reviewed-at/by, so an approval decision is auditable rather than
-- just a status that silently flipped.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'reviewed_at');
SET @sql = IF(@x = 0,
  'ALTER TABLE users ADD COLUMN reviewed_at DATETIME NULL, ADD COLUMN reviewed_by BIGINT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_approval');
SET @sql = IF(@x = 0,
  'ALTER TABLE users ADD INDEX idx_users_approval (role, approval_status)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Same audit trail on the business side.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'reviewed_at');
SET @sql = IF(@x = 0,
  'ALTER TABLE businesses ADD COLUMN reviewed_at DATETIME NULL, ADD COLUMN reviewed_by BIGINT UNSIGNED NULL, ADD COLUMN approval_note VARCHAR(300) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
