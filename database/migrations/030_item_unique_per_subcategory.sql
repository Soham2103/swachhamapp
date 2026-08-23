-- ============================================================
-- SWACHHAM — One item name per sub-category
-- Migration: 030_item_unique_per_subcategory.sql
--
-- "+ Create New Item" lets a Super Admin add a catalogue item
-- from either price list, so the rule that stops
--
--     Men -> Shirts -> Shirt
--     Men -> Shirts -> Shirt
--
-- has to hold in the DATABASE and not only in the service. The
-- service checks first so the operator gets a sentence rather
-- than a constraint violation -- "Item already exists in this
-- subcategory." -- but a check-then-insert is racy on its own,
-- and it only covers the one code path that runs it. This index
-- covers every path, including a direct INSERT.
--
-- An item's `category_id` IS its sub-category: the two-level tree
-- lives in `service_categories.parent_id` and items hang off the
-- leaf. So uniqueness on (category_id, name) is exactly "one item
-- of this name per sub-category", and the SAME name under a
-- different sub-category stays legal -- Men -> Shirts -> Shirt and
-- Women -> Shirts -> Shirt are different items and both are fine.
--
-- SAFE TO RUN ON EXISTING DATA. The index is only added when the
-- table currently holds no duplicate pair, so the migration can
-- never fail half way through a deploy; if duplicates were ever
-- introduced it does nothing and leaves them to be resolved by
-- hand. Verified against the live catalogue (128 items, zero
-- duplicate pairs) before this was written.
--
-- Idempotent. MySQL only. No row is created, changed or deleted.
-- ============================================================

SET @has_index = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'services'
     AND INDEX_NAME = 'uq_service_category_name'
);

-- Duplicates would make the ALTER fail, so it is not attempted.
SET @has_dupes = (
  SELECT COUNT(*) FROM (
    SELECT category_id, name
      FROM services
     WHERE category_id IS NOT NULL
     GROUP BY category_id, name
    HAVING COUNT(*) > 1
  ) d
);

SET @sql = IF(@has_index = 0 AND @has_dupes = 0,
  'ALTER TABLE services ADD UNIQUE KEY uq_service_category_name (category_id, name)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
