-- ============================================================
-- SWACHHAM — The number an order was placed on, and the payment ledger
-- Migration: 032_order_mobile_and_payment_receipts.sql
--
-- Two additions. Nothing is renamed, nothing is dropped, and no existing
-- row is rewritten.
--
--   orders.placed_by_mobile     which number the person actually used
--   business_payment_receipts   money received against an invoice
--
-- Idempotent. MySQL 8.
-- ============================================================


-- ============================================================
-- 1. THE NUMBER THE ORDER WAS PLACED ON
--
-- A business is reached on several numbers -- its primary contact's and up
-- to three alternative contacts' -- and any of them can sign in. Until now
-- the order recorded only WHICH ACCOUNT placed it, and every document
-- therefore printed the account's own number, whichever number the person
-- had actually proved by OTP.
--
-- This column records that number, once, at the moment the order is created.
--
-- IT IS A SNAPSHOT AND IS NEVER UPDATED. Editing a contact, replacing an
-- alternative number or changing the primary contact must not silently
-- rewrite what an order from six months ago says: the number on the document
-- is the number the order was placed on, permanently.
--
-- NULLable on purpose. Orders that already exist were placed before anything
-- recorded this, and there is no honest value to backfill them with -- the
-- information was never captured. They stay NULL, and every reader falls back
-- to the account's number for them, which is exactly what those orders have
-- always shown.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'placed_by_mobile');
SET @sql = IF(@x = 0,
  'ALTER TABLE orders ADD COLUMN placed_by_mobile VARCHAR(20) NULL AFTER business_user_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 2. PAYMENT RECEIPTS
--
-- Money received from a business against an invoice. One row per receipt,
-- and the row is the RECORD OF A TRANSACTION -- it is never edited to
-- reflect a later payment, because a ledger that gets rewritten is not a
-- ledger.
--
-- WHY THE BALANCES ARE STORED AND NOT ONLY DERIVED.
--
-- `previous_balance`, `current_invoice_amount`, `total_amount_due` and
-- `remaining_balance` are all computable from the rows before this one. They
-- are written down anyway, because the receipt is a DOCUMENT: the Billing
-- Receipt PDF handed to the business states these four figures, and it has to
-- keep stating them even after a later receipt changes what the outstanding
-- balance is today. Recomputing them at print time would silently reissue an
-- old receipt with new numbers.
--
-- The running balance the NEXT receipt starts from is nonetheless taken from
-- the last stored `remaining_balance`, not from anything on a screen, so a
-- refresh, a second window or a different admin all see the same figure.
--
-- NO INVOICE TABLE EXISTS. Invoices are computed on demand by
-- `gstInvoice.service` from the orders in a billing period, so there is no
-- invoices row to point a foreign key at. `invoice_number` is therefore
-- stored as the text it is, together with the period it was raised for --
-- which is what makes the same invoice identifiable again.
--
-- `business_id` is the relationship to the business, as it is everywhere
-- else; no business detail is copied in beside it.
-- ============================================================
CREATE TABLE IF NOT EXISTS business_payment_receipts (
  id                     BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  -- Human-facing receipt number, unique. Generated per business in sequence.
  receipt_number         VARCHAR(40) NOT NULL,

  business_id            BIGINT UNSIGNED NOT NULL,

  -- The invoice this payment is against, as text: invoices are computed, not
  -- stored, so there is no row to reference. The period is kept beside it so
  -- the same invoice can be rebuilt and compared.
  invoice_number         VARCHAR(120) NOT NULL,
  invoice_period_from    DATE NOT NULL,
  invoice_period_to      DATE NOT NULL,

  payment_date           DATE NOT NULL,
  payment_type           ENUM('CASH','CARD','UPI','NETBANKING') NOT NULL,
  -- Only meaningful for NETBANKING; the service writes NULL for every other
  -- type, so a reference cannot be attached to a cash payment by mistake.
  payment_reference      VARCHAR(120) NULL,

  -- The four figures the receipt states, frozen as at the moment it was
  -- issued. See the note above for why they are stored rather than derived.
  previous_balance       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  current_invoice_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_amount_due       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  payment_received       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  remaining_balance      DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  notes                  VARCHAR(500) NULL,

  -- Who recorded it. RESTRICT is deliberate: a receipt is a financial record
  -- and must not vanish with the account of whoever entered it.
  recorded_by            BIGINT UNSIGNED NULL,

  created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_bpr_receipt_number (receipt_number),
  -- "This business's receipts, newest first" is the query the screen makes.
  INDEX idx_bpr_business (business_id, created_at),
  INDEX idx_bpr_invoice (business_id, invoice_number),
  CONSTRAINT fk_bpr_business FOREIGN KEY (business_id)
    REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT fk_bpr_recorded_by FOREIGN KEY (recorded_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
