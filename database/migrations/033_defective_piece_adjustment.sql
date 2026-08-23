-- ============================================================
-- SWACHHAM — Defective piece adjustment
-- Migration: 033_defective_piece_adjustment.sql
--
-- The Sorter finds damaged pieces while sorting. The order must bill for
-- what is usable, the original figure must stay readable, and nothing that
-- already works may change meaning.
--
-- Idempotent. MySQL 8. Nothing is renamed and nothing is dropped.
-- ============================================================


-- ============================================================
-- 1. WHAT `order_items.quantity` MEANS -- AND WHY IT DOES NOT CHANGE
--
-- Every reader in the application already treats `quantity` as THE quantity
-- that counts: the invoice sums it, `total_price` is derived from it,
-- `total_weight_kg` is derived from it, the order total sums those, and the
-- Order Confirmation PDF prints it.
--
-- So `quantity` stays exactly what it is -- the BILLABLE quantity -- and the
-- adjustment writes the reduced figure into it. Every one of those readers
-- then bills, weighs and prints the adjusted order without being touched,
-- which is the whole reason nothing downstream needs a second formula and
-- nothing can be left half-updated.
--
-- What was missing is where the ORIGINAL went, and that is the column below.
--
--   original_quantity   the pieces the order was placed for. A SNAPSHOT:
--                       written once, never reduced by an adjustment.
--   defective_quantity  how many of them the Sorter found damaged.
--   quantity            original_quantity - defective_quantity. Billable.
--
-- THE PHYSICAL COUNT IS `original_quantity`, NOT `quantity`. A defective
-- towel is damaged, not absent -- it was collected, it is on the shelf, and
-- it carries a barcode. So the garment rows, the expected scan count and the
-- acceptance/delivery match all read `original_quantity`; billing reads
-- `quantity`. Getting this backwards would make a correctly scanned order
-- report 10/8 and refuse to match.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'original_quantity');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items ADD COLUMN original_quantity INT NULL AFTER quantity',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
    AND COLUMN_NAME = 'defective_quantity');
SET @sql = IF(@x = 0,
  'ALTER TABLE order_items ADD COLUMN defective_quantity INT NOT NULL DEFAULT 0 AFTER original_quantity',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------
-- BACKFILL. Every line that exists today was ordered and never adjusted, so
-- its original quantity IS its current quantity and nothing was defective.
-- This is not a guess: no adjustment has ever been recorded, because the
-- mechanism did not exist.
--
-- Only rows that have not been filled in are touched, so re-running this
-- migration cannot overwrite a real original with a reduced quantity.
-- ------------------------------------------------------------
UPDATE order_items SET original_quantity = quantity WHERE original_quantity IS NULL;


-- ============================================================
-- 2. THE ADJUSTMENT AUDIT TRAIL
--
-- One row per adjustment EVENT, not one per item. Correcting "2 defective"
-- to "3 defective" writes a second row; it does not edit the first. The
-- history is therefore the sequence of what was claimed and when, and the
-- order line carries only the current answer.
--
-- WHY THE AMOUNTS ARE STORED. `original_amount` and `adjusted_amount` are
-- computable from the quantities and the unit price, and they are written
-- down anyway, because this is the record of a MONEY CHANGE: it has to keep
-- stating what the line cost before and after this particular adjustment,
-- even after a later adjustment moves both figures again.
--
-- `unit_price` is copied in for the same reason -- it is the price the
-- arithmetic actually used, so the row can be checked without trusting that
-- the order line still holds the same rate.
--
-- NO SEPARATE AUDIT SYSTEM. `order_status_history` records STATUS changes and
-- has no quantity or amount columns; it is left alone, and an adjustment
-- deliberately writes nothing to it, because an adjustment is not a status
-- change (see the note in the service).
-- ============================================================
CREATE TABLE IF NOT EXISTS order_item_adjustments (
  id                         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  order_id                   BIGINT UNSIGNED NOT NULL,
  order_item_id              BIGINT UNSIGNED NOT NULL,

  -- The line as it was ordered, repeated on every row so one row explains
  -- itself without reading the ones before it.
  original_quantity          INT NOT NULL,
  -- What this adjustment REPLACED, so a correction shows its own movement.
  previous_defective_quantity INT NOT NULL DEFAULT 0,
  defective_quantity         INT NOT NULL,
  final_quantity             INT NOT NULL,

  unit_price                 DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  -- original_quantity x unit_price, and final_quantity x unit_price.
  original_amount            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  adjusted_amount            DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  reason                     VARCHAR(500) NULL,

  -- Who made the call. SET NULL rather than CASCADE: the adjustment moved
  -- money and must not disappear with the account of whoever recorded it.
  adjusted_by                BIGINT UNSIGNED NULL,
  adjusted_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_oia_order (order_id, adjusted_at),
  INDEX idx_oia_item (order_item_id, id),
  CONSTRAINT fk_oia_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oia_item FOREIGN KEY (order_item_id)
    REFERENCES order_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_oia_user FOREIGN KEY (adjusted_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
-- 3. THE NOTIFICATION SEND LOG
--
-- One row per ATTEMPT to tell the customer about the adjustment, mirroring
-- what `order_defects` already records for a defect photo: who it went to,
-- what Meta answered, and when.
--
-- WHY IT IS ITS OWN TABLE. `order_defects` is a photo report -- its
-- `photo_url` is NOT NULL and its notification is ABOUT that photo. A
-- quantity adjustment has no photo, so a row could not be written there
-- without inventing one. This table carries no evidence and no audit of its
-- own: it records deliveries, and the adjustment it refers to stays in
-- `order_item_adjustments`.
--
-- WHY IT POINTS AT AN ADJUSTMENT ROW. The Sorter must not be able to spam the
-- customer by tapping Send twice, but must be able to notify again after
-- CHANGING the quantity. `last_adjustment_id` is what tells those two apart:
-- a send is refused when a successful one already exists for the same latest
-- adjustment, and allowed the moment a new adjustment supersedes it.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_adjustment_notifications (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  order_id              BIGINT UNSIGNED NOT NULL,
  -- The newest adjustment the message described. See above.
  last_adjustment_id    BIGINT UNSIGNED NULL,

  status                ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
  -- The number Meta was asked to deliver to, as it was sent.
  sent_to               VARCHAR(20) NULL,
  message_id            VARCHAR(128) NULL,
  error                 VARCHAR(500) NULL,
  -- The template actually used, so a delivery can be traced to the approved
  -- template it went out on rather than to whatever is configured today.
  template_name         VARCHAR(120) NULL,

  sent_by               BIGINT UNSIGNED NULL,
  sent_at               DATETIME NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_oan_order (order_id, created_at),
  INDEX idx_oan_adjustment (last_adjustment_id),
  CONSTRAINT fk_oan_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oan_adjustment FOREIGN KEY (last_adjustment_id)
    REFERENCES order_item_adjustments(id) ON DELETE SET NULL,
  CONSTRAINT fk_oan_user FOREIGN KEY (sent_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
