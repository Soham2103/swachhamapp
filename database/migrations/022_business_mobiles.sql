-- ============================================================
-- SWACHHAM — Many mobile numbers per business
-- Migration: 022_business_mobiles.sql
--
-- A business is reached on more than one number, and any of them
-- should be able to sign in to that business. Until now a number
-- lived in two places that could disagree: businesses.mobile_number
-- and business_users.mobile_number. Business 1 already had two
-- different values across those columns.
--
-- business_mobiles becomes the single list. The old columns are
-- left in place and still read as a fallback, so nothing that
-- currently works stops working.
--
-- How many a business may hold is per-business and set by the super
-- admin (businesses.max_mobiles). The backfill seeds that allowance
-- from what each business already has, so no business starts over
-- its own limit. One number is always compulsory, which is enforced
-- in the service on delete rather than by a constraint that could
-- not explain itself.
--
-- Idempotent. MySQL only.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_mobiles (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  business_id   BIGINT UNSIGNED NOT NULL,
  mobile_number VARCHAR(15) NOT NULL,
  label         VARCHAR(60) NULL,
  -- The number shown as the business's main contact. Exactly one row
  -- per business should carry it; the service keeps that true.
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- The same number twice on ONE business is always a mistake. The
  -- same number on two DIFFERENT businesses is allowed on purpose --
  -- the super admin is warned instead of blocked.
  UNIQUE KEY uk_bm_business_mobile (business_id, mobile_number),
  INDEX idx_bm_mobile (mobile_number),
  CONSTRAINT fk_bm_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Per-business allowance ----
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'max_mobiles');
SET @sql = IF(@x = 0,
  'ALTER TABLE businesses ADD COLUMN max_mobiles INT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- Backfill: every number a business already answers on ----
-- From the business row.
INSERT IGNORE INTO business_mobiles (business_id, mobile_number, label, is_primary)
SELECT b.id, TRIM(b.mobile_number), 'Primary', TRUE
  FROM businesses b
 WHERE NULLIF(TRIM(b.mobile_number), '') IS NOT NULL;

-- From each account on the business.
INSERT IGNORE INTO business_mobiles (business_id, mobile_number, label, is_primary)
SELECT bu.business_id, TRIM(bu.mobile_number), 'Account', FALSE
  FROM business_users bu
 WHERE NULLIF(TRIM(bu.mobile_number), '') IS NOT NULL;

-- A business whose business-row number was blank still needs one
-- primary, so promote its earliest number.
UPDATE business_mobiles bm
  JOIN (
    SELECT business_id, MIN(id) AS first_id
      FROM business_mobiles
     GROUP BY business_id
    HAVING SUM(is_primary) = 0
  ) pick ON pick.first_id = bm.id
   SET bm.is_primary = TRUE;

-- ---- Allowance starts at what each business already holds ----
UPDATE businesses b
  JOIN (SELECT business_id, COUNT(*) AS n FROM business_mobiles GROUP BY business_id) c
    ON c.business_id = b.id
   SET b.max_mobiles = GREATEST(b.max_mobiles, c.n);
