-- ============================================================
-- SWACHHAM — What the rider counted at the door, and when
-- Migration: 069_rider_acceptance_count.sql
--
-- `rider_jobs.door_acceptance_mode` (migration 062) already records
-- WHICH answer the rider gave. It does not record the COUNT that
-- "With Counting" produced, nor when the answer was given — so a
-- hotel told "Order is checked at door" had no way to learn what
-- was actually checked, and nothing could show when.
--
-- TOTAL PIECES, ONE NUMBER. Not a per-item breakdown: the count is
-- what the rider and the hotel's staff agreed at the door, on a
-- trolley of mixed laundry, and `order_items` already holds the
-- per-item quantities the order was booked for. Storing a second
-- per-item set here would invite two answers to the same question.
--
-- BOTH COLUMNS ARE NULLABLE, and stay NULL for:
--   - every job accepted before this existed,
--   - a customer pickup, which has no counting step at all,
--   - WITHOUT_COUNT, where the whole point is that nothing was
--     counted. The MODE says which of these it is; a 0 here would
--     claim the rider counted zero pieces.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- rider_jobs.accepted_piece_count ----
SET @sql = (SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'rider_jobs'
              AND COLUMN_NAME = 'accepted_piece_count'),
    'SELECT ''rider_jobs.accepted_piece_count already exists''',
    'ALTER TABLE rider_jobs
       ADD COLUMN accepted_piece_count INT UNSIGNED NULL
         COMMENT ''Total pieces the rider counted at the door. NULL unless the mode is WITH_COUNT.''
         AFTER door_acceptance_mode'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- rider_jobs.door_accepted_at ----
SET @sql = (SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'rider_jobs'
              AND COLUMN_NAME = 'door_accepted_at'),
    'SELECT ''rider_jobs.door_accepted_at already exists''',
    'ALTER TABLE rider_jobs
       ADD COLUMN door_accepted_at DATETIME NULL
         COMMENT ''When the rider completed the acceptance step. NULL means it has not been done.''
         AFTER accepted_piece_count'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
