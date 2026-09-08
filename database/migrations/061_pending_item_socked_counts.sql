-- SWACHHAM — Sorter: the socked cloth counts
-- Migration: 061_pending_item_socked_counts.sql
--
-- Two more counts on the row that already carries a line's cloth counts. The
-- Sorter now counts socked cloth as its own pair of figures — white socked and
-- colour socked — alongside the white and colour cloth counts from 060.
--
-- ON THE EXISTING ROW, NOT A NEW ONE. `pending_item` already holds exactly one
-- row per `order_item_id`, enforced by the unique key from 060, and these are
-- two more facts about the same line. A second table, or a second row, would
-- mean one line's counts had to be assembled from two places.
--
-- SEPARATE FROM `socked_cloth_count`, which 060 added and which is left alone.
-- That column holds what was recorded under the older single "Socked Cloths"
-- box; these two replace it going forward. Existing rows keep whatever they
-- hold there, and nothing rewrites them: a count that was taken is not
-- re-interpreted by a later migration.
--
-- NULLABLE, and NULL means "not counted" — a different fact from 0, "counted,
-- and there were none". Every row that already exists predates these two boxes
-- and stays NULL rather than gaining zeroes nobody counted.
--
-- UNSIGNED because a count of cloths is never negative, so the column refuses
-- it rather than relying on the API to.
--
-- Guarded the same way as every other ADD COLUMN in this project: the runner
-- replays every migration on each run, so a second run must be a no-op rather
-- than a duplicate-column error.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pending_item'
    AND COLUMN_NAME = 'white_socked');
SET @sql = IF(@c = 0,
  'ALTER TABLE pending_item ADD COLUMN white_socked INT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pending_item'
    AND COLUMN_NAME = 'color_socked');
SET @sql = IF(@c = 0,
  'ALTER TABLE pending_item ADD COLUMN color_socked INT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
