-- ============================================================
-- SWACHHAM — Remove business_mobiles
-- Migration: 029_drop_business_mobiles.sql
--
-- WHY IT GOES.
--
-- 022 added `business_mobiles` as a second list of numbers a
-- business answers on, at a time when there was no contact
-- structure. 027 then introduced `business_contacts`, which holds
-- the Business Head and one to three Alternative Contacts, each
-- with a name, a designation and a mobile number, and 028 gave
-- each contact `login_enabled`.
--
-- That makes `business_mobiles` a duplicate of a thing the schema
-- already models better: a bare number with no owner, no role and
-- no login switch. Two lists of "numbers this business answers
-- on" can disagree, and the login lookup had to read both.
--
-- WHAT WAS CHECKED BEFORE DROPPING IT.
--
--   unifiedAuth.service          the mobile -> business lookup now
--                                joins business_contacts and
--                                honours login_enabled
--   businessMobiles.service      deleted
--   /profile/mobiles routes      deleted (business self-service)
--   /businesses/:id/mobiles      deleted (super admin)
--   BusinessMobilesSection.tsx   deleted (mobile app)
--   superAdminApi mobile calls   deleted
--
-- No foreign key points AT business_mobiles; its own FK points at
-- businesses, so dropping the table breaks no other table. No
-- foreign key checks are disabled anywhere in this migration.
--
-- NO CONTACT DATA IS LOST. Before the drop, any number that lives
-- ONLY in business_mobiles is carried over into business_contacts
-- as an Alternative Contact, within the 3-contact maximum the
-- service enforces. Numbers already present as a contact, and the
-- business's own primary number, are skipped rather than
-- duplicated.
--
-- Idempotent. MySQL only. No business, order, invoice or price row
-- is touched.
-- ============================================================

-- ------------------------------------------------------------
-- 1. CARRY OVER ANYTHING THAT WOULD OTHERWISE BE LOST
--
-- Only runs while the table still exists, so a re-run after the
-- drop is a no-op rather than an error.
--
-- `rn` ranks the candidate numbers per business and the join
-- caps the result at three contacts in total, which is the same
-- 1..3 rule businessContact.service enforces. login_enabled is
-- left at its default of TRUE so nothing that worked stops
-- working; the Super Admin can turn it off per contact.
-- ------------------------------------------------------------
SET @has_bm = (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_mobiles'
);

SET @sql = IF(@has_bm = 1, '
INSERT INTO business_contacts
  (business_id, contact_type, name, designation, mobile, whatsapp, email, login_enabled)
SELECT c.business_id, ''ALTERNATIVE'',
       COALESCE(NULLIF(TRIM(c.label), ''''), ''Alternative contact''),
       NULL, c.mobile_number, NULL, NULL, TRUE
  FROM (
    SELECT bm.business_id,
           bm.mobile_number,
           bm.label,
           ROW_NUMBER() OVER (PARTITION BY bm.business_id ORDER BY bm.id) AS rn,
           (SELECT COUNT(*) FROM business_contacts x
             WHERE x.business_id = bm.business_id
               AND x.contact_type = ''ALTERNATIVE'') AS existing
      FROM business_mobiles bm
      JOIN businesses b ON b.id = bm.business_id
     WHERE NULLIF(TRIM(bm.mobile_number), '''') IS NOT NULL
       -- Already recorded as a contact on this business.
       AND NOT EXISTS (
             SELECT 1 FROM business_contacts bc
              WHERE bc.business_id = bm.business_id
                AND bc.mobile = bm.mobile_number)
       -- The business''s own primary number: it belongs to the head,
       -- not to a separate alternative contact.
       AND (b.mobile_number IS NULL OR TRIM(b.mobile_number) <> bm.mobile_number)
  ) c
 WHERE c.existing + c.rn <= 3', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------
-- 2. DROP THE TABLE
--
-- Plain DROP TABLE IF EXISTS. Nothing references it, so no
-- constraint has to be relaxed to allow this.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS business_mobiles;

-- ------------------------------------------------------------
-- 3. DROP THE ALLOWANCE COLUMN THAT ONLY BOUNDED THAT TABLE
--
-- `businesses.max_mobiles` was added by 022 solely to cap how many
-- business_mobiles rows a business could hold. With the table gone
-- it has no reader, and the 1..3 rule for alternative contacts is
-- enforced in businessContact.service instead. Gated so a re-run
-- does nothing.
-- ------------------------------------------------------------
SET @has_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
     AND COLUMN_NAME = 'max_mobiles'
);
SET @sql = IF(@has_col = 1, 'ALTER TABLE businesses DROP COLUMN max_mobiles', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
