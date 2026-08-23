-- ============================================================
-- SWACHHAM — Partial order completion / pending items
-- Migration: 034_partial_order_completion.sql
--
-- Some items of an order are ready while others need more time. The ready
-- ones must go; the rest stay with Swachham, on the SAME order.
--
-- Idempotent. MySQL 8. Nothing is renamed and nothing is dropped.
-- ============================================================


-- ============================================================
-- 1. ITEM-LEVEL STATUS
--
-- `order_items` had no status of its own: an item's state was whatever the
-- ORDER's state said, which is exactly why one item could not lag behind the
-- others. This is the minimum that fixes it.
--
--   PROCESSING  with Swachham, being worked on. The default, and what every
--               line means the moment an order is placed.
--   READY       finished, and free to leave with the order's next dispatch.
--   PENDING     deliberately HELD BACK by the Sorter: it needs more time
--               while the rest of the order goes out.
--
-- THREE VALUES, NOT SIX. `DELIVERED` and `COMPLETED` are not here because no
-- delivery workflow exists in this application to set them -- there is no
-- rider app and nothing anywhere writes orders.status = 'DELIVERED'. Adding
-- states nothing can reach would be inventing a workflow, not supporting one.
-- `DEFECTIVE` is not here either: a defective piece is a QUANTITY on the line
-- (`defective_quantity`, migration 033), not a state of the whole item, and
-- an item can be pending without anything being damaged.
--
-- PENDING IS NOT DEFECTIVE. Nothing in this migration touches price,
-- quantity, invoice or payment: holding an item back costs nobody anything.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'item_status');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items
     ADD COLUMN item_status ENUM(''PROCESSING'',''READY'',''PENDING'')
       NOT NULL DEFAULT ''PROCESSING'' AFTER defective_quantity',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- When the Sorter last held this item back, and why. NULL on an item that has
-- never been pending -- the reason belongs to the hold, not to the item.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'pending_reason');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items ADD COLUMN pending_reason VARCHAR(500) NULL AFTER item_status',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------
-- BACKFILL, from the only evidence there is: the order's own status.
--
-- An order that has reached READY_FOR_DELIVERY or beyond had ALL of its items
-- finished -- that is what those statuses meant before an item could lag, so
-- READY is not a guess for them, it is what they have always asserted.
-- Everything else is still being worked on, which is PROCESSING, the default.
--
-- NOTHING IS BACKFILLED AS PENDING. No item has ever been held back, because
-- there was no way to hold one back.
--
-- Only rows still at the default are touched, so re-running cannot overwrite
-- a real hold with READY.
-- ------------------------------------------------------------
UPDATE order_items oi
   JOIN orders o ON o.id = oi.order_id
   SET oi.item_status = 'READY'
 WHERE oi.item_status = 'PROCESSING'
   AND o.status IN ('READY_FOR_DELIVERY','DELIVERY_ASSIGNED','OUT_FOR_DELIVERY',
                    'DELIVERED','COMPLETED');


-- ============================================================
-- 2. THE ORDER STATUS FOR "SOME OUT, SOME STILL HERE"
--
-- One new value, added to the END of both enums so every existing value keeps
-- its ordinal and no stored row changes meaning.
--
--   PARTIALLY_COMPLETED   at least one item has moved on, and at least one is
--                         still being held at the facility.
--
-- WHY A REAL STATUS RATHER THAN A FLAG. Every reader in the application
-- already switches on `orders.status` -- the Sorter queue, the tracking
-- timeline, the Business list filters. A boolean beside it would have to be
-- threaded through all of them, and any reader that forgot would show a
-- part-finished order as finished. One more value in the enum they already
-- read is the smaller change and the harder one to get wrong.
--
-- WHY ONLY ONE. "All items pending" needs no status of its own: an order with
-- nothing ready is simply not ready, which RECEIVED_AT_FACILITY already says,
-- and inventing PENDING_ITEMS for it would add a state that means the same as
-- one that exists.
--
-- ORDER OF OPERATIONS. `orders` first, then `order_status_history`: the
-- history row is written after the order is updated, so the column that
-- receives it must accept the value by the time anything writes one.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%PARTIALLY_COMPLETED%');
SET @sql = IF(@x = 0,
  'ALTER TABLE orders MODIFY COLUMN status
     ENUM(''ORDER_PLACED'',''PICKUP_SCHEDULED'',''PICKUP_ASSIGNED'',''PICKED_UP'',
          ''RECEIVED_AT_FACILITY'',''SORTING'',''WASHING'',''DRYING'',''IRONING'',
          ''QUALITY_CHECK'',''READY_FOR_DELIVERY'',''DELIVERY_ASSIGNED'',
          ''OUT_FOR_DELIVERY'',''DELIVERED'',''COMPLETED'',''CANCELLED'',
          ''PARTIALLY_COMPLETED'')
     NOT NULL DEFAULT ''ORDER_PLACED''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_status_history'
    AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%PARTIALLY_COMPLETED%');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_status_history MODIFY COLUMN status
     ENUM(''ORDER_PLACED'',''PICKUP_SCHEDULED'',''PICKUP_ASSIGNED'',''PICKED_UP'',
          ''RECEIVED_AT_FACILITY'',''SORTING'',''WASHING'',''DRYING'',''IRONING'',
          ''QUALITY_CHECK'',''READY_FOR_DELIVERY'',''DELIVERY_ASSIGNED'',
          ''OUT_FOR_DELIVERY'',''DELIVERED'',''COMPLETED'',''CANCELLED'',
          ''PARTIALLY_COMPLETED'')
     NOT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 3. AUDITING AN ITEM-LEVEL CHANGE, IN THE TABLE THAT ALREADY AUDITS
--
-- `order_status_history` is this application's order audit trail and it stays
-- exactly that. Three nullable columns let one row describe an ITEM's move as
-- well as the order's, rather than standing up a second history table beside
-- the first for the same kind of fact.
--
-- A row written for an item still carries `status` -- the ORDER's status at
-- that moment -- so the existing tracking timeline, which reads only
-- `status`, `notes` and `created_at`, keeps working and simply sees one more
-- entry. Every column added here is NULL on every row the table already
-- holds, and NULL on every order-level row written from now on, which is what
-- tells the two kinds of row apart.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_status_history'
    AND COLUMN_NAME = 'order_item_id');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_status_history
     ADD COLUMN order_item_id BIGINT UNSIGNED NULL AFTER order_id,
     ADD COLUMN previous_item_status VARCHAR(20) NULL AFTER order_item_id,
     ADD COLUMN new_item_status VARCHAR(20) NULL AFTER previous_item_status,
     ADD INDEX idx_osh_item (order_item_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The foreign key is added separately so a re-run cannot try to create it
-- twice, and ON DELETE CASCADE matches how the order's own rows behave.
SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_status_history'
    AND CONSTRAINT_NAME = 'fk_osh_item');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_status_history
     ADD CONSTRAINT fk_osh_item FOREIGN KEY (order_item_id)
       REFERENCES order_items(id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
