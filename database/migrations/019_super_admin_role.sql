-- ============================================================
-- SWACHHAM — SUPER_ADMIN role
-- Migration: 019_super_admin_role.sql
--
-- Adds a SUPER_ADMIN tier above ADMIN on users.role.
--
-- Privilege model: SUPER_ADMIN is a superset of ADMIN. Everything
-- an ADMIN can reach, a SUPER_ADMIN can reach too — the route
-- guards list both roles rather than swapping one for the other,
-- so adding this tier never takes access away from an existing
-- admin.
--
-- Purely additive: extending an ENUM with a new trailing value
-- rewrites no rows and invalidates no existing value, so every
-- CUSTOMER / BUSINESS / ADMIN row is untouched.
--
-- Idempotent: gated on the column's current definition, so a
-- replay of the full migration set is a no-op. MySQL only.
-- ============================================================

SET @has_super = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'users'
     AND COLUMN_NAME  = 'role'
     AND COLUMN_TYPE LIKE '%SUPER_ADMIN%'
);

SET @sql = IF(@has_super = 0,
  'ALTER TABLE users MODIFY COLUMN role ENUM(''CUSTOMER'',''BUSINESS'',''ADMIN'',''SUPER_ADMIN'') NOT NULL DEFAULT ''CUSTOMER''',
  'SELECT 1');

PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
