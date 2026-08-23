-- ============================================================
-- SWACHHAM — Manager role + creation-request approval workflow
-- Migration: 027_manager_creation_requests.sql
--
-- A Manager may PROPOSE a business, a rider or a sorter; only a
-- Super Admin may bring one into existence. The proposal therefore
-- needs somewhere to live before the entity does, which is what
-- `creation_requests` is: one table for all three kinds, because
-- the workflow is identical and three parallel tables would be
-- three copies of the same approval logic.
--
-- The MANAGER role itself already exists — migration 021 added it
-- to `users.role`, and `unifiedAuth` already treats it as a
-- password-signin role. Nothing here re-adds it.
--
-- Idempotent. MySQL 8. No table dropped, no row deleted.
-- ============================================================

-- ============================================================
-- BUSINESSES — billing cycle
--
-- The project had no billing configuration of any kind (no table,
-- no column, no constant), so the cycle is added to the business
-- record itself, which is the thing it describes.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'billing_cycle');
SET @sql = IF(@x = 0,
  'ALTER TABLE businesses ADD COLUMN billing_cycle ENUM(''MONTHLY'',''QUARTERLY'',''HALF_YEARLY'',''YEARLY'') NULL AFTER pan_number',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- BUSINESSES — retire the four requested columns
--
-- Checked before writing this migration: `gst_business_type`,
-- `gst_registered_on` and `gst_verified_at` appear in exactly one
-- place in the codebase — the INSERT in superAdmin.service —
-- and are never read back by any query, API response or screen.
-- That INSERT is updated in the same change, so nothing is left
-- referring to them.
--
-- `businesses.reviewed_at` is dropped. `users.reviewed_at` is a
-- DIFFERENT column on a different table and is still used by the
-- rider/sorter approval path — it is deliberately untouched.
-- `reviewed_by` stays on both: it records WHO decided, which is
-- still wanted; only the timestamp was asked for.
--
-- Each drop is gated on the column existing, so re-running is safe.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'gst_business_type');
SET @sql = IF(@x > 0, 'ALTER TABLE businesses DROP COLUMN gst_business_type', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'gst_registered_on');
SET @sql = IF(@x > 0, 'ALTER TABLE businesses DROP COLUMN gst_registered_on', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'gst_verified_at');
SET @sql = IF(@x > 0, 'ALTER TABLE businesses DROP COLUMN gst_verified_at', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'reviewed_at');
SET @sql = IF(@x > 0, 'ALTER TABLE businesses DROP COLUMN reviewed_at', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- BUSINESS CONTACTS
--
-- One row per person, never a comma-separated list: a contact has
-- five fields of its own and there may be up to four of them, so
-- it is a relation.
--
--   contact_type = 'BUSINESS_HEAD'  exactly one per business
--   contact_type = 'ALTERNATIVE'    one to three per business
--
-- The "exactly one head" rule is enforced by uq_bc_head, a unique
-- key on (business_id, contact_type) that only bites for the head
-- because `head_marker` is NULL for alternatives and MySQL does
-- not compare NULLs as equal. The 1..3 range for alternatives is
-- enforced in the service, where a countable rule belongs.
-- ============================================================
CREATE TABLE IF NOT EXISTS business_contacts (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  business_id  BIGINT UNSIGNED NOT NULL,
  contact_type ENUM('BUSINESS_HEAD','ALTERNATIVE') NOT NULL,
  name         VARCHAR(255) NOT NULL,
  designation  VARCHAR(255) NULL,
  mobile       VARCHAR(20) NULL,
  whatsapp     VARCHAR(20) NULL,
  email        VARCHAR(255) NULL,
  -- Non-NULL only for the head, so the unique key below applies to
  -- it alone. Generated, so it can never disagree with contact_type.
  head_marker  TINYINT UNSIGNED
                 GENERATED ALWAYS AS (IF(contact_type = 'BUSINESS_HEAD', 1, NULL)) STORED,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bc_head (business_id, head_marker),
  INDEX idx_bc_business (business_id),
  INDEX idx_bc_type (contact_type),
  CONSTRAINT fk_bc_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- CREATION REQUESTS
--
-- The Manager's proposal, before the thing exists.
--
-- ONE TABLE FOR THREE KINDS. Business, rider and sorter requests
-- differ only in what is inside `payload`; submit, list, approve
-- and reject are the same operation on all three. Three tables
-- would mean three copies of the authorisation and the state
-- machine, which is where the bugs would be.
--
-- `payload` is JSON, holding the submitted form as it was
-- submitted. It is NOT the source of truth for anything security
-- relevant: on approval the service re-validates every field and
-- re-verifies the GSTIN, so a payload edited in the database
-- still cannot create an unverified business.
--
-- NO PASSWORD IS EVER STORED HERE, hashed or otherwise. Credentials
-- are generated at approval time and exist in memory only long
-- enough to be emailed.
--
-- `created_entity_id` records what approval produced, which is what
-- makes a failed credential email recoverable: the account is
-- findable and can be reset without the request being replayed.
-- ============================================================
CREATE TABLE IF NOT EXISTS creation_requests (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  request_type      ENUM('BUSINESS','RIDER','SORTER') NOT NULL,
  status            ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',

  -- The manager who submitted it. RESTRICT, not CASCADE: a request
  -- is a record of a decision and must not vanish with its author.
  requested_by      BIGINT UNSIGNED NOT NULL,
  payload           JSON NOT NULL,

  -- A copy of the two identifying fields, lifted out of the payload
  -- so the queue can be listed, searched and duplicate-checked
  -- without opening the JSON of every row.
  subject_name      VARCHAR(255) NOT NULL,
  subject_email     VARCHAR(255) NULL,

  reviewed_by       BIGINT UNSIGNED NULL,
  rejection_reason  VARCHAR(500) NULL,
  approved_at       DATETIME NULL,

  -- What approval created, and whether the credentials reached the
  -- recipient. PENDING while unsent, FAILED when the mail server
  -- refused — which is what the Super Admin's resend acts on.
  created_entity_id BIGINT UNSIGNED NULL,
  email_status      ENUM('NOT_SENT','SENT','FAILED') NOT NULL DEFAULT 'NOT_SENT',
  email_error       VARCHAR(500) NULL,
  email_sent_at     DATETIME NULL,

  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_cr_status (status),
  INDEX idx_cr_type_status (request_type, status),
  -- The Manager's own list is filtered by this, so it is indexed.
  INDEX idx_cr_requested_by (requested_by),
  INDEX idx_cr_created (created_at),
  CONSTRAINT fk_cr_requested_by FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cr_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
