-- ============================================================
-- SWACHHAM — Fortnightly billing + alternative-contact login
-- Migration: 028_billing_cycle_contact_login.sql
--
-- Deliberately small. Most of what this feature needs already
-- exists and is reused rather than duplicated:
--
--   Category -> Subcategory -> Item
--       `service_categories.parent_id` already models exactly two
--       levels (16 top-level, 15 sub, no deeper), and items hang
--       off the sub-category. No new category table.
--
--   establishment_name / establishment_address
--       Already columns on `businesses` since the original schema.
--
--   pan_number, billing_cycle
--       Already present. Only the FORTNIGHTLY value is new.
--
--   business_price_list (business_id, item_id, laundry_type)
--       Already unique on the triple. Unchanged.
--
-- Idempotent. MySQL only. No table dropped, no row deleted.
-- ============================================================

-- ============================================================
-- BILLING CYCLE — add FORTNIGHTLY
--
-- Extending an ENUM with a new value rewrites no rows and
-- invalidates none of the existing four. Gated on the column's
-- current definition so a re-run is a no-op.
-- ============================================================
SET @has_fortnightly = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
     AND COLUMN_NAME = 'billing_cycle' AND COLUMN_TYPE LIKE '%FORTNIGHTLY%'
);
SET @sql = IF(@has_fortnightly = 0,
  'ALTER TABLE businesses MODIFY COLUMN billing_cycle ENUM(''MONTHLY'',''FORTNIGHTLY'',''QUARTERLY'',''HALF_YEARLY'',''YEARLY'') NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- ALTERNATIVE CONTACT LOGIN ROUTING
--
-- An alternative contact's mobile number identifies the business
-- so the app can show that business's login page. It is NOT a
-- credential: the person still signs in with the business email
-- and password. `login_enabled` is the Super Admin's switch for
-- whether a given number may be used for that routing at all.
--
-- Defaults to TRUE so contacts that already exist keep working;
-- turning it off is a deliberate act.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_contacts'
    AND COLUMN_NAME = 'login_enabled');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_contacts ADD COLUMN login_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER email',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The routing lookup is by mobile number, so it is indexed.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_contacts'
    AND INDEX_NAME = 'idx_bc_mobile');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_contacts ADD INDEX idx_bc_mobile (mobile)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- ALTERNATIVE CONTACTS NO LONGER CARRY AN EMAIL
--
-- The column is NOT dropped: the BUSINESS_HEAD row uses it, and
-- it is the head's email that becomes the login username. Only
-- ALTERNATIVE rows stop collecting one, which the service
-- enforces by writing NULL — so the column keeps its one real
-- purpose and nothing that depends on it breaks.
--
-- Existing alternative rows are cleared of an email they should
-- no longer hold. Head rows are untouched.
-- ============================================================
UPDATE business_contacts
   SET email = NULL, whatsapp = NULL
 WHERE contact_type = 'ALTERNATIVE'
   AND (email IS NOT NULL OR whatsapp IS NOT NULL);

-- ============================================================
-- ORDER LINE SNAPSHOT — category and sub-category
--
-- `order_items` already snapshots the item, its name, the
-- laundry type, the unit price and the quantity. The category
-- it sat in is the one part of the line that is still read live
-- through `category_id`, so a later re-parenting of the
-- catalogue would silently rewrite an old invoice's grouping.
-- These two text columns freeze it at order time.
--
-- Backfilled from the catalogue as it stands now, which is the
-- correct value for every existing line.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'category_name');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items ADD COLUMN category_name VARCHAR(150) NULL AFTER category_id,
                           ADD COLUMN subcategory_name VARCHAR(150) NULL AFTER category_name',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The item's own category is the SUB-category; its parent is the
-- top-level one. A flat category (no parent) is the category, with
-- no sub-category.
UPDATE order_items oi
  JOIN service_categories c ON c.id = oi.category_id
  LEFT JOIN service_categories p ON p.id = c.parent_id
   SET oi.category_name    = COALESCE(p.name, c.name),
       oi.subcategory_name = IF(p.id IS NULL, NULL, c.name)
 WHERE oi.category_name IS NULL;
