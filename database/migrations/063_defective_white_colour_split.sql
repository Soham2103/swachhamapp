-- ============================================================
-- SWACHHAM — Sorter: defective pieces split white / colour
-- Migration: 063_defective_white_colour_split.sql
--
-- Idempotent. MySQL 8. Additive only: no table dropped, no row
-- deleted, and no existing column altered or back-filled.
-- ============================================================
--
--
-- 1. WHAT CHANGES
--
-- A defective quantity used to be one number. The Sorter now
-- records it as two — how many of the defective pieces were
-- WHITE and how many were COLOUR — so the defect can be taken
-- off the right cloth count.
--
--
-- 2. WHY `order_items` AND NOT `pending_item`
--
-- `pending_item` looks like the natural home: it already holds
-- the white and colour counts these figures reduce. But a row
-- there exists only once a line has been COUNTED, and a
-- defective piece can be recorded on a line nobody has counted
-- yet. Hanging the split off that table would mean inventing a
-- counts row to hold a defect, and a row of NULL counts is not
-- the same fact as a line that was counted and found empty.
--
-- `order_items` always has the row, and it is already where
-- `defective_quantity` lives. The split belongs beside the
-- number it splits.
--
--
-- 3. `defective_quantity` IS UNTOUCHED AND STILL THE TOTAL
--
-- READ THIS BEFORE CHANGING THE PRICING PATH. Everything that
-- bills, re-prices, reports or adjusts reads
-- `defective_quantity`, and it keeps meaning exactly what it
-- means today: the total number of defective pieces on the
-- line. The service writes it as white + colour, so every
-- existing consumer is correct without knowing the split
-- exists. Nothing about money changes in this migration.
--
--
-- 4. THE COUNTS ARE REDUCED BY SUBTRACTION, NOT BY REWRITING
--
-- The white and colour counts in `pending_item` are NOT edited
-- when a defect is recorded. The effective count is derived:
--
--     effective white  = white_cloth_count - white_defective_quantity
--     effective colour = color_cloth_count - color_defective_quantity
--
-- Derived rather than stored because a defective quantity
-- REPLACES the previous one (a correction from 2 to 3 leaves 3,
-- not 5). Mutating the counts would have to add the old figure
-- back before taking the new one off, and any path that missed
-- that step would silently destroy a count that was taken by
-- hand. Subtraction at the point of use cannot drift, and it
-- leaves the counted figure in the database exactly as counted.
--
--
-- 5. NULLABLE, AND NULL MEANS "NOT SPLIT"
--
-- Every row that already exists carries a `defective_quantity`
-- that was recorded before there was a split to record, so both
-- columns stay NULL rather than guessing a division that was
-- never made. A reader must treat NULL as "no split recorded"
-- and fall back to the total, not as zero.
--
-- UNSIGNED because a count of pieces is never negative.
-- ============================================================


SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'white_defective_quantity');
SET @sql = IF(@c = 0,
  'ALTER TABLE order_items
     ADD COLUMN white_defective_quantity INT UNSIGNED NULL
       COMMENT ''Defective pieces that were white. NULL = no split recorded.''
     AFTER defective_quantity',
  'SELECT ''order_items.white_defective_quantity already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'color_defective_quantity');
SET @sql = IF(@c = 0,
  'ALTER TABLE order_items
     ADD COLUMN color_defective_quantity INT UNSIGNED NULL
       COMMENT ''Defective pieces that were colour. NULL = no split recorded.''
     AFTER white_defective_quantity',
  'SELECT ''order_items.color_defective_quantity already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
