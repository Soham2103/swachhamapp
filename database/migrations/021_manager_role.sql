-- ============================================================
-- SWACHHAM — MANAGER role
-- Migration: 021_manager_role.sql
--
-- Joins the group that signs in with a username and password
-- (ADMIN, SUPER_ADMIN, MANAGER, SORTER, RIDER) as opposed to
-- customers, who sign in with an OTP alone.
--
-- Additive: extending an ENUM with a new trailing value rewrites
-- no rows and invalidates no existing value.
--
-- Idempotent: gated on the column's current definition.
-- ============================================================

SET @has_manager = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'users'
     AND COLUMN_NAME  = 'role'
     AND COLUMN_TYPE LIKE '%MANAGER%'
);

SET @sql = IF(@has_manager = 0,
  'ALTER TABLE users MODIFY COLUMN role ENUM(''CUSTOMER'',''BUSINESS'',''ADMIN'',''SUPER_ADMIN'',''SORTER'',''RIDER'',''MANAGER'') NOT NULL DEFAULT ''CUSTOMER''',
  'SELECT 1');

PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
