-- ============================================================
-- SWACHHAM — One invoice number sequence PER BUSINESS,
--            shared by Hotel and Guest
-- Migration: 066_per_business_invoice_serial.sql
--
-- Idempotent. MySQL 8. Additive: no column dropped, no stored
-- invoice number rewritten, no row deleted.
-- ============================================================
--
--
-- 1. WHAT CHANGES
--
-- Invoice numbers become:
--
--     SWCH/INV/27    Hotel
--     SWCG/INV/28    Guest
--
-- The prefix says which kind of invoice it is. The DIGITS come
-- from one counter per business, shared by both kinds — so a
-- hotel account's invoices run 1, 2, 3, 4 whether each one is a
-- Hotel or a Guest invoice. There is no separate Guest counter,
-- and the sequence is never reset by type.
--
-- It replaces ONE GLOBAL counter (migration 056) shared by every
-- business, which numbered `SWC/HL/INV/0059` — a serial that
-- said where the invoice sat in the whole application's history
-- rather than in this account's.
--
--
-- 2. WHY A NEW COLUMN AND NOT `serial`
--
-- `business_invoices.serial` holds the GLOBAL serial, under a
-- unique key over that column alone. Per-business numbering
-- makes serial 1 exist once per business, which that key forbids
-- outright — and rewriting the column would destroy the record
-- of what the already-issued invoices were numbered under.
--
-- So the new number is its own column, unique PER BUSINESS.
-- `serial` keeps its values, keeps its meaning and keeps its
-- key; it is simply no longer allocated. Every invoice issued
-- before this migration therefore still resolves to exactly the
-- number it was issued under — which is the one rule invoice
-- numbering cannot break.
--
--
-- 3. WHERE EACH BUSINESS'S SEQUENCE STARTS
--
-- At the number of invoices that business has already been
-- issued, plus one. An account with two invoices on record
-- continues at 3.
--
-- Not at 1, because a sequence that restarts under a new prefix
-- would number this account's third invoice "1". Not from
-- `MAX(serial)` either: that is the GLOBAL serial, so seeding
-- from it would start a brand-new account's own sequence at 61
-- because sixty invoices exist elsewhere.
--
-- The already-issued invoices are NOT renumbered. They keep the
-- numbers they carry; the count only decides where the new
-- sequence picks up.
-- ============================================================


-- ============================================================
-- THE PER-BUSINESS COUNTER
--
-- One row per business, holding the number the NEXT invoice for
-- that business will take. `business_id` is the primary key, so
-- the allocation in `gstInvoice.service` can be a single
-- INSERT .. ON DUPLICATE KEY UPDATE — atomic under the row lock,
-- with no read-then-write window two simultaneous invoices could
-- both slip through.
--
-- NO AUTO_INCREMENT COLUMN, deliberately: the allocator reads
-- the value back with LAST_INSERT_ID(), which an AUTO_INCREMENT
-- on this table would overwrite with the new row's id.
-- ============================================================
CREATE TABLE IF NOT EXISTS business_invoice_sequence (
  business_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  next_value  INT UNSIGNED    NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
);


-- ============================================================
-- THE NUMBER AN INVOICE WAS ISSUED UNDER, WITHIN ITS BUSINESS
--
-- NULL on every invoice issued before this migration: those are
-- numbered under the old scheme and are left exactly as they
-- are. The unique key is (business_id, business_serial), which
-- is what lets two businesses each have an invoice 1 while
-- making a duplicate within one business impossible.
-- ============================================================
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND COLUMN_NAME = 'business_serial');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD COLUMN business_serial INT UNSIGNED NULL
       COMMENT ''Invoice number within this business, shared by Hotel and Guest.''
     AFTER serial',
  'SELECT ''business_invoices.business_serial already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_invoices'
    AND INDEX_NAME = 'uq_business_invoice_serial');
SET @sql = IF(@c = 0,
  'ALTER TABLE business_invoices
     ADD UNIQUE KEY uq_business_invoice_serial (business_id, business_serial)',
  'SELECT ''uq_business_invoice_serial already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- THE SAME NUMBER ON THE CLAIM
--
-- `invoice_serial_claims` records which number an invoice took
-- the moment it was allocated, so a second download of the same
-- invoice reuses it instead of minting another (migration 057).
-- It needs the per-business number for the same reason the
-- invoice row does.
--
-- `serial` becomes NULLABLE: a claim written under the new
-- scheme has no global serial to record, and NOT NULL would
-- force the allocator to invent one.
-- ============================================================
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_serial_claims'
    AND COLUMN_NAME = 'business_serial');
SET @sql = IF(@c = 0,
  'ALTER TABLE invoice_serial_claims
     ADD COLUMN business_serial INT UNSIGNED NULL
       COMMENT ''Claimed invoice number within this business.''
     AFTER serial',
  'SELECT ''invoice_serial_claims.business_serial already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_serial_claims'
    AND COLUMN_NAME = 'serial' AND IS_NULLABLE = 'NO');
SET @sql = IF(@c = 1,
  'ALTER TABLE invoice_serial_claims MODIFY COLUMN serial INT UNSIGNED NULL',
  'SELECT ''invoice_serial_claims.serial is already nullable''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_serial_claims'
    AND INDEX_NAME = 'uq_business_claim_serial');
SET @sql = IF(@c = 0,
  'ALTER TABLE invoice_serial_claims
     ADD UNIQUE KEY uq_business_claim_serial (business_id, business_serial)',
  'SELECT ''uq_business_claim_serial already exists''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- SEEDING — see note 3
--
-- Every business that has ever been issued an invoice gets a
-- counter starting one past however many it has. A business with
-- none gets no row here at all: the allocator's
-- INSERT .. ON DUPLICATE KEY UPDATE creates it on first use and
-- hands out 1, which is where a new account should start.
--
-- ON DUPLICATE KEY UPDATE next_value = next_value so a re-run
-- cannot rewind a counter that has already handed numbers out.
-- ============================================================
INSERT INTO business_invoice_sequence (business_id, next_value)
SELECT business_id, COUNT(*) + 1
  FROM business_invoices
 GROUP BY business_id
ON DUPLICATE KEY UPDATE next_value = next_value;
