-- ============================================================
-- SWACHHAM — Pending is a QUANTITY, not a flag on the item
-- Migration: 035_pending_quantity.sql
--
-- 034 let the Sorter hold an item back, but only whole: ticking "Bedsheet"
-- held all five. What is actually needed is "two of the five stay, three go",
-- so the hold is a NUMBER on the line and not a state of it.
--
-- Idempotent. MySQL 8. Nothing is renamed and nothing is dropped.
-- ============================================================


-- ============================================================
-- 1. HOW MANY PIECES ARE BEING HELD
--
-- The line now carries four figures, and each answers a different question:
--
--   original_quantity   pieces collected. The physical count, never reduced.
--   defective_quantity  of those, how many are damaged. Affects BILLING.
--   quantity            original - defective. What is billed.
--   pending_quantity    of those, how many are not finished yet. Affects
--                       DISPATCH, and nothing else.
--
-- DELIVERY QUANTITY IS NOT STORED. It is `original_quantity -
-- pending_quantity`, exactly, always -- a stored copy would be a second
-- source of truth that could disagree with the two figures it is derived
-- from, and there is no moment at which it means anything else. It is
-- computed wherever it is needed and returned by the API, so no caller has to
-- do the subtraction and no caller may send it.
--
-- PENDING AND DEFECTIVE ARE INDEPENDENT AXES. A piece can be damaged, or
-- unfinished, or both, and neither figure constrains the other. Only
-- `defective_quantity` touches money; `pending_quantity` never does, which is
-- why the invoice does not move when an item is held back.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'pending_quantity');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items
     ADD COLUMN pending_quantity INT NOT NULL DEFAULT 0 AFTER defective_quantity',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 2. THE ITEM STATE THAT ONLY A QUANTITY SPLIT CAN PRODUCE
--
--   PROCESSING        with Swachham, not yet finished with.
--   READY             finished; every piece goes with the next dispatch.
--   PARTIALLY_PENDING some pieces go, some stay. The state 034 could not
--                     express, and the reason for this migration.
--   PENDING           every piece of this line is being held.
--
-- Appended to the end of the enum, so every existing value keeps its ordinal
-- and no stored row changes meaning.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'item_status' AND COLUMN_TYPE LIKE '%PARTIALLY_PENDING%');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items MODIFY COLUMN item_status
     ENUM(''PROCESSING'',''READY'',''PENDING'',''PARTIALLY_PENDING'')
     NOT NULL DEFAULT ''PROCESSING''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------
-- BACKFILL. A line that 034 marked PENDING was held WHOLE -- that was the
-- only kind of hold it could record -- so its pending quantity is all of it.
-- This is not a guess; it is what PENDING meant when the row was written.
--
-- Every other line has nothing held, which the column default already says.
--
-- Guarded on `pending_quantity = 0` so re-running cannot overwrite a real
-- partial hold with the full quantity.
-- ------------------------------------------------------------
UPDATE order_items
   SET pending_quantity = COALESCE(original_quantity, quantity)
 WHERE item_status = 'PENDING' AND pending_quantity = 0;
