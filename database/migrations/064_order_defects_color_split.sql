-- SWACHHAM — Defect reports: the white/colour split
-- Migration: 064_order_defects_color_split.sql
--
-- `order_defects` already records HOW MANY pieces a report is about, in
-- `defective_quantity`. These two record how that figure divides between white
-- and colour, which is what the Sorter actually types into Mark Defective.
--
-- ADDED, NOT REPLACING. `defective_quantity` stays exactly as it is and goes
-- on being written and read by everything that already does: the WhatsApp
-- message, the queue card, the defect list. These two sit beside it.
--
-- NULLABLE, and NULL means "not split". Every report that already exists was
-- taken before the two boxes were recorded here, and there is no honest way to
-- divide its total between the two colours after the fact — so it stays NULL
-- rather than gaining a guess. A reader wanting the total uses
-- `defective_quantity`, which is populated on every row, old and new.
--
-- UNSIGNED because a count of pieces is never negative, so the column refuses
-- it rather than relying on the API to.
--
-- NAMED TO MATCH THE COLUMNS THAT ALREADY EXIST. `order_items` carries
-- `white_defective_quantity` and `color_defective_quantity` for the same two
-- figures, so these use those exact names -- one spelling of each across the
-- database, and a query joining the two tables reads the same either side.
--
-- Guarded the same way as every other ADD COLUMN in this project: the runner
-- replays every migration on each run, so a second run must be a no-op rather
-- than a duplicate-column error.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_defects'
    AND COLUMN_NAME = 'white_defective_quantity');
SET @sql = IF(@c = 0,
  'ALTER TABLE order_defects ADD COLUMN white_defective_quantity INT UNSIGNED NULL AFTER defective_quantity',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_defects'
    AND COLUMN_NAME = 'color_defective_quantity');
SET @sql = IF(@c = 0,
  'ALTER TABLE order_defects ADD COLUMN color_defective_quantity INT UNSIGNED NULL AFTER white_defective_quantity',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

