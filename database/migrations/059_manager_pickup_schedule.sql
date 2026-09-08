-- ============================================================
-- SWACHHAM — The pickup a Manager assigns when approving an order
-- Migration: 059_manager_pickup_schedule.sql
--
-- Idempotent. MySQL 8. No table dropped, no row deleted, no
-- existing order's status or schedule changed.
-- ============================================================
--
--
-- 1. WHAT THIS ADDS
--
-- A Manager now names the collection when they accept a booking:
-- a date and a time, saved against that order and shown to the
-- customer and to the business.
--
-- Four columns on `orders`, beside the two that migration 053
-- already added for the approval itself:
--
--     assigned_pickup_date   DATE
--     assigned_pickup_time   TIME
--     pickup_assigned_by     BIGINT UNSIGNED
--     pickup_assigned_at     DATETIME
--
--
-- 2. WHY ON `orders` AND NOT ONLY ON `pickups`
--
-- `pickups` already carries scheduled_date and a time_slot_start
-- / time_slot_end window, and every order has a row in it from
-- the moment it is created -- both order flows insert one. On the
-- Business side that row is explicitly a PLACEHOLDER: see
-- `BusinessTimeSlotScreen.resolveProvisionalPickup`, which sends
-- tomorrow's first slot only because the create endpoint still
-- insists on a schedule, and says in as many words that the
-- Manager overwrites it.
--
-- So `pickups` cannot answer "has a Manager assigned a pickup
-- yet?" -- it is never empty, and a placeholder there is
-- indistinguishable from a real appointment. The requirement is
-- that NOTHING is shown until a Manager has actually chosen, and
-- that is what these columns record. NULL means unassigned, and
-- every order that predates this migration is NULL, which is the
-- truth about them: no Manager ever named a pickup.
--
-- The `pickups` row is still kept in step by the application --
-- `managerOrderApproval.service` writes both in one transaction
-- -- so the rider and the delivery-turnaround rule, which read
-- `pickups`, act on the Manager's decision rather than on the
-- placeholder. These columns are the RECORD OF THE DECISION;
-- `pickups` remains the operational schedule.
--
--
-- 3. TIME, NOT A SLOT
--
-- `assigned_pickup_time` is a single TIME because the Manager
-- names a moment ("4:00 PM"), which is what the customer is
-- shown. `pickups.time_slot_start` / `time_slot_end` keep their
-- window shape, unchanged; the application derives the window
-- from the assigned time.
--
--
-- 4. NO FOREIGN KEY ON pickup_assigned_by
--
-- Matching `manager_approved_by` from migration 053, and for the
-- same reason: a manager account that is later removed must not
-- take the record of who scheduled a collection with it.
-- ============================================================


-- ---- orders.assigned_pickup_date / assigned_pickup_time ----
--
-- Guarded on the first column being absent, so re-running is a
-- no-op. All four are added together because they are one fact.
SET @sql := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'orders'
              AND COLUMN_NAME = 'assigned_pickup_date'),
    'SELECT ''orders.assigned_pickup_date already exists''',
    'ALTER TABLE orders
       ADD COLUMN assigned_pickup_date DATE NULL
         COMMENT ''Pickup date a Manager assigned. NULL = none assigned yet.''
       AFTER manager_approved_by,
       ADD COLUMN assigned_pickup_time TIME NULL
         COMMENT ''Pickup time a Manager assigned. NULL = none assigned yet.''
       AFTER assigned_pickup_date,
       ADD COLUMN pickup_assigned_by BIGINT UNSIGNED NULL
         COMMENT ''The Manager who assigned it. No FK: the record outlives the account.''
       AFTER assigned_pickup_time,
       ADD COLUMN pickup_assigned_at DATETIME NULL
         COMMENT ''When it was last assigned or changed.''
       AFTER pickup_assigned_by'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ---- An index for "what is being collected on this day" ----
--
-- Nothing reads it that way yet. It is here because the column
-- is a date that operations will inevitably be filtered by, and
-- adding it now costs one statement on a table that is small
-- today. NULLs are not indexed heavily by InnoDB, so the
-- unassigned majority costs almost nothing.
SET @sql := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'orders'
              AND INDEX_NAME = 'idx_orders_assigned_pickup'),
    'SELECT ''idx_orders_assigned_pickup already exists''',
    'CREATE INDEX idx_orders_assigned_pickup
       ON orders (assigned_pickup_date, assigned_pickup_time)'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
