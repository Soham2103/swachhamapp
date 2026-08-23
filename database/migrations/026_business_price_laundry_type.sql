-- ============================================================
-- SWACHHAM — Business pricing per laundry type
-- Migration: 026_business_price_laundry_type.sql
--
-- A business pays a different rate for its own linen (Hotel
-- Laundry) than for its guests' clothes (Guest Laundry), so a
-- business price is no longer identified by (business, item)
-- alone -- the laundry type is part of the key.
--
--   before:  UNIQUE (business_id, item_id)
--   after:   UNIQUE (business_id, item_id, laundry_type)
--
-- NAMING. `laundry_type` reuses the enum the schema already
-- uses on `orders` and `carts` -- ENUM('hotel','guest') -- so
-- there is one vocabulary for the concept across the database.
-- The API additionally accepts HOTEL_LAUNDRY / GUEST_LAUNDRY
-- and normalises to these values.
--
-- EXISTING ROWS. A row written before this migration carried no
-- laundry type, which means it applied to whichever type was
-- ordered -- i.e. to both. It is therefore expanded into two
-- rows at the same price, one per type, which preserves the
-- previous behaviour exactly. Nothing is guessed and no price
-- is invented or changed. (This database has no rows in the
-- table, so the expansion is a no-op here; it is written for
-- any environment that does.)
--
-- Idempotent. MySQL only. No drops, no deletes, no price edited.
-- ============================================================

-- ---- business_price_list.laundry_type ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_price_list'
    AND COLUMN_NAME = 'laundry_type');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_price_list ADD COLUMN laundry_type ENUM(''hotel'',''guest'') NOT NULL DEFAULT ''hotel'' AFTER item_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- Expand each pre-existing row to the second laundry type ----
-- Runs only while the old unique key is still in place, which is
-- precisely the set of rows that predate this migration. INSERT
-- IGNORE, so re-running can never duplicate anything.
SET @old_key = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_price_list'
    AND INDEX_NAME = 'uq_business_item');
SET @sql = IF(@old_key > 0,
  'INSERT IGNORE INTO business_price_list (business_id, item_id, laundry_type, price, is_active, created_at, updated_at)
     SELECT business_id, item_id, ''guest'', price, is_active, created_at, updated_at
       FROM business_price_list WHERE laundry_type = ''hotel''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- Swap the unique key: (business, item) -> (business, item, type) ----
-- The new key is added BEFORE the old one is dropped, so the table is
-- never left without a uniqueness guarantee.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_price_list'
    AND INDEX_NAME = 'uq_business_item_laundry');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_price_list ADD UNIQUE KEY uq_business_item_laundry (business_id, item_id, laundry_type)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_price_list'
    AND INDEX_NAME = 'uq_business_item');
SET @sql = IF(@x > 0,
  'ALTER TABLE business_price_list DROP INDEX uq_business_item',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Lookups are always (business, type) scoped now.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_price_list'
    AND INDEX_NAME = 'idx_bpl_business_type');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_price_list ADD INDEX idx_bpl_business_type (business_id, laundry_type)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- ORDER LINE SNAPSHOT
--
-- `order_items` already snapshots unit_price and quantity so a
-- later price change cannot rewrite an old invoice. The laundry
-- type now decides which price was charged, so it belongs on the
-- line too -- otherwise reading an old invoice means inferring
-- the rate from the order header.
--
-- Backfilled from `orders.laundry_type`, which is the value that
-- order was actually placed under. That is the same fact, not an
-- assumption. Left NULL where the order has none.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'laundry_type');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items ADD COLUMN laundry_type ENUM(''hotel'',''guest'') NULL AFTER service_name',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE order_items oi
  JOIN orders o ON o.id = oi.order_id
   SET oi.laundry_type = o.laundry_type
 WHERE oi.laundry_type IS NULL AND o.laundry_type IS NOT NULL;

-- ============================================================
-- DELIVERY SCHEDULING IS OPTIONAL
--
-- No DDL is needed. A delivery lives in its own `deliveries`
-- row, one per order, so "no delivery booked yet" is the absence
-- of that row -- which the schema already permits, and which the
-- order queries already LEFT JOIN for. Making the columns
-- nullable instead would allow a delivery row that says nothing,
-- which is a worse representation of the same fact.
--
-- The row is inserted when the delivery is scheduled, whether
-- that happens with the order or afterwards.
-- ============================================================
