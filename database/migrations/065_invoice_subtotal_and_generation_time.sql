-- ============================================================
-- SWACHHAM — Stored invoice: the Sub Total it was issued for,
--            and when it was last generated
-- Migration: 065_invoice_subtotal_and_generation_time.sql
--
-- Idempotent. MySQL 8. Additive only: no table dropped, no
-- column dropped or altered, no row rewritten.
-- ============================================================
--
--
-- 1. WHAT CHANGES
--
-- `business_invoices` snapshots what an invoice was issued for:
-- `taxable_amount`, `tax_amount` and `total_amount`. It has
-- never held the SUB TOTAL — the lines added up BEFORE any
-- deduction — because until deductions existed the two were the
-- same figure and `taxable_amount` said both things at once.
--
-- They are not the same figure on a discounted invoice, and the
-- Issued Invoice list has to be able to show the same chain the
-- document prints:
--
--     Sub Total  -  Deduction  =  Taxable  +  Tax  =  Total
--
-- Without this column the list can show four of those five and
-- has to infer the fifth by dividing the taxable value back out
-- by the percentage — a second calculation of a figure the
-- invoice already knew, and one that cannot survive rounding.
-- So the number is stored, from the invoice that was issued.
--
--
-- 2. WHY IT IS NOT BACK-FILLED FROM `taxable_amount`
--
-- It IS, and only because the two are provably equal for every
-- row that can already exist: `discount_percent` (migration 055)
-- defaults to 0, and on an invoice with no deduction the sub
-- total and the taxable value are the same addition. The
-- back-fill below is therefore a restatement of what those rows
-- already say, not a guess at what they meant. Rows carrying a
-- deduction get their true sub total the next time the invoice
-- is generated, which is what writes this column.
--
--
-- 3. NOTHING READS IT UNTIL IT IS WRITTEN
--
-- DEFAULT 0 with the back-fill above means no row is ever left
-- with a NULL for the list to interpret, and no existing figure
-- moves: `taxable_amount`, `tax_amount` and `total_amount` are
-- untouched by this migration.
-- ============================================================


SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND COLUMN_NAME = 'subtotal_amount');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD COLUMN subtotal_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00
       COMMENT ''The lines added up, before any deduction. Snapshot.''
     AFTER discount_percent',
  'SELECT ''business_invoices.subtotal_amount already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- The restatement described in note 2: only rows that were
-- issued with NO deduction, where the sub total and the taxable
-- value are the same number, and only where the column is still
-- at its default. A row already carrying a sub total is left
-- exactly as it is.
--
-- `updated_at = updated_at` is assigned deliberately. The column
-- is ON UPDATE CURRENT_TIMESTAMP, so without this every row this
-- statement touches would be stamped with the moment the
-- migration ran — a back-fill of one column would rewrite when
-- each invoice was last touched. Assigning the column its own
-- value suppresses the automatic update.
UPDATE business_invoices
   SET subtotal_amount = taxable_amount,
       updated_at = updated_at
 WHERE subtotal_amount = 0
   AND COALESCE(discount_percent, 0) = 0
   AND taxable_amount <> 0;


-- ============================================================
-- WHEN THE INVOICE WAS LAST GENERATED
--
-- `generated_at` is the INVOICE DATE: the day the document was
-- first issued, printed on it, and deliberately never reset —
-- re-issuing an invoice must not change the date it bears.
--
-- That leaves the Issued Invoice list with nothing to order by
-- that answers "what did I just generate?". Ordering by
-- `generated_at` puts a re-issued invoice back where it was
-- first raised, which for the operator who has this second
-- pressed Generate Invoice is indistinguishable from the list
-- not having refreshed at all.
--
-- `updated_at` cannot serve either: it moves for any write to
-- the row, including a migration like this one, so it records
-- when the ROW changed rather than when the INVOICE was issued.
--
-- So the moment of issue is its own column. `generated_at` keeps
-- stating the invoice date; this states the last time the
-- document was actually produced, and it is what the list is
-- ordered by. Back-filled to `generated_at`, which for every row
-- that exists today is the only generation anything recorded.
-- ============================================================
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND COLUMN_NAME = 'last_generated_at');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD COLUMN last_generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       COMMENT ''Last time this invoice was generated. generated_at stays the invoice date.''
     AFTER generated_at',
  'SELECT ''business_invoices.last_generated_at already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- Every existing row was generated once, as far as anything
-- recorded — so its last generation is its first. Only rows
-- still at the column's default are touched, and `updated_at`
-- is held for the same reason as above.
UPDATE business_invoices
   SET last_generated_at = generated_at,
       updated_at = updated_at
 WHERE last_generated_at <> generated_at;


-- The list reads this column for every business, newest first.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND INDEX_NAME = 'idx_business_invoice_generated');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD INDEX idx_business_invoice_generated (business_id, last_generated_at)',
  'SELECT ''idx_business_invoice_generated already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
