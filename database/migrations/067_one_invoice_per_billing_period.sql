-- ============================================================
-- SWACHHAM — One invoice per business, per billing period
-- Migration: 067_one_invoice_per_billing_period.sql
--
-- Idempotent. MySQL 8. Additive: no column dropped, no invoice
-- number rewritten, no row deleted.
-- ============================================================
--
--
-- 1. WHAT THIS ENFORCES
--
-- That a business cannot have two invoices covering the same
-- billing period and laundry type. The application decides
-- between updating an invoice and issuing a new one — see
-- `findInvoiceForPeriod` — and this is the constraint that makes
-- a mistake there impossible rather than merely unlikely.
--
-- It matters because the check and the write are two statements:
-- two operators generating September's invoice at the same
-- instant can both find nothing and both insert. The unique key
-- is what turns that race into one row and one error instead of
-- two invoices for one month.
--
--
-- 2. WHY A GENERATED COLUMN
--
-- The key has to include the laundry type: Hotel and Guest are
-- two documents over one period, with different totals and
-- different numbers, and both must be allowed.
--
-- But `laundry_type` is NULLable — NULL means an invoice
-- covering both types, which is what everything issued before
-- the split means — and MySQL treats NULLs as DISTINCT in a
-- unique key. Two untyped invoices for one period would both be
-- accepted, which is the exact case this is meant to stop.
--
-- So the key is built over a generated column that maps NULL to
-- ''. It is STORED rather than VIRTUAL because a unique index
-- over a virtual column cannot be used to reject a duplicate as
-- early or as cheaply, and this column never changes for a row
-- once written.
--
-- The ENUM is deliberately NOT made NOT NULL: that would rewrite
-- every existing row's meaning, and an invoice that genuinely
-- covered both types would start claiming it covered neither.
--
--
-- 3. NOTHING IS MERGED HERE
--
-- Invoices already stored under ad-hoc date ranges — 1–29, 1–30
-- and 1–31 August for one business, from before the period was
-- pinned to the registered cycle — are left exactly as they are.
-- They are not duplicates under this key (their periods differ),
-- they keep their numbers, and the application adopts the one
-- that falls inside a cycle when that cycle is next billed.
-- Merging them is a data decision, not a schema one.
-- ============================================================


SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND COLUMN_NAME = 'laundry_type_key');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD COLUMN laundry_type_key VARCHAR(10)
       GENERATED ALWAYS AS (COALESCE(laundry_type, '''')) STORED
       COMMENT ''laundry_type with NULL folded to \'\'\'\', so it can be part of a unique key.''',
  'SELECT ''business_invoices.laundry_type_key already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ONE INVOICE PER BUSINESS + BILLING PERIOD + TYPE.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND INDEX_NAME = 'uq_invoice_billing_period');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD UNIQUE KEY uq_invoice_billing_period
       (business_id, period_from, period_to, laundry_type_key)',
  'SELECT ''uq_invoice_billing_period already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
