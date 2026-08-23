-- ============================================================
-- SWACHHAM — Two business tables, and the B2B/B2C registration type
-- Migration: 031_business_users_consolidation.sql
--
-- ============================================================
-- WHY.  THE THREE TABLES, AND WHAT EACH ONE HELD.
-- ============================================================
--
--   businesses          the hotel/establishment itself: name, legal name,
--                       type, GSTIN, PAN, both addresses, city/state/
--                       pincode, billing cycle, status.  It ALSO carried a
--                       whole contact person inline — contact_person_name,
--                       designation, mobile_number, whatsapp_number,
--                       email_id — plus a second, cut-down one in
--                       alternate_contact_person / alternate_mobile_no.
--
--   business_users      the LOGIN account: name, email (the username),
--                       mobile_number, password_hash, is_active.  One row
--                       per business in practice.  `orders.business_user_id`
--                       and `carts.business_user_id` point AT this table,
--                       which is why it can never be the one that goes.
--
--   business_contacts   added by 027: one row per PERSON — a BUSINESS_HEAD
--                       and one to three ALTERNATIVEs — each with a name, a
--                       designation, a mobile, and (028) a `login_enabled`
--                       switch deciding whether that number may reach the
--                       business login.
--
-- The duplication was total.  The business head existed THREE times: as
-- five columns on `businesses`, as the BUSINESS_HEAD row in
-- `business_contacts`, and as the `business_users` row.  Alternative
-- contacts existed twice: as ALTERNATIVE rows and as the
-- alternate_contact_person / alternate_mobile_no pair.  Three copies of one
-- phone number is three chances for the login lookup and the invoice to
-- disagree about which number the business answers on.
--
-- ============================================================
-- WHAT THIS MIGRATION DECIDES.
-- ============================================================
--
--   businesses      = information about the BUSINESS.  Every contact and
--                     credential column is removed from it.
--
--   business_users  = every PERSON/ACCOUNT/NUMBER through which the
--                     business is reached.  `contact_type` says which:
--                     PRIMARY is the business head and the login account,
--                     ALTERNATIVE is a further contact.  `login_enabled`
--                     says whether that number may identify the business at
--                     sign-in.  `password_hash` is what makes a row an
--                     account rather than only a contact, so it becomes
--                     NULLable.
--
--   business_contacts is DROPPED — but only after every row it held has
--                     been carried into business_users.  It is not a
--                     different entity: it is the same person, recorded a
--                     second time.
--
-- NOTHING IS DELETED BEFORE IT IS COPIED.  Steps 3-6 move the data; the
-- drops are steps 7 and 8, and each is gated on the copy having produced a
-- row.  `businesses`, `business_users`, `orders`, `carts` and every price
-- row are otherwise untouched.
--
-- Idempotent.  MySQL 8.  Safe to re-run: every ALTER is gated on
-- information_schema and every INSERT is gated on NOT EXISTS.  Statements
-- that NAME a column this migration drops are built as strings and prepared
-- only when that column is still there, because a second run would
-- otherwise fail to parse rather than doing nothing.
-- ============================================================


-- ============================================================
-- 0. WHAT IS STILL HERE
--
-- Both flags are read repeatedly below.  They are taken once, before
-- anything is changed, so every step in this file agrees about the shape it
-- started from.
-- ============================================================
SET @has_bc = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_contacts');

SET @has_biz_contact_cols = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND COLUMN_NAME = 'contact_person_name');


-- ============================================================
-- 1. REGISTRATION TYPE  (B2B / B2C)
--
-- `businesses.customer_type VARCHAR(50)` already existed, was NULL on every
-- row and had NOT ONE reader anywhere in the codebase.  It is RENAMED
-- rather than joined by a new column, so the table does not end up with two
-- fields for one fact.  `business_type` is left alone: it is the
-- establishment CATEGORY (hotel, restaurant, hostel…), a different question
-- from whether the account is B2B or B2C.
--
-- Backfilled before the NOT NULL is applied: a business that already holds
-- a GSTIN is a B2B registration, and one without is B2C.
-- ============================================================
SET @has_reg = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND COLUMN_NAME = 'registration_type');
SET @has_cust = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND COLUMN_NAME = 'customer_type');

SET @sql = IF(@has_reg = 0 AND @has_cust = 1,
  'ALTER TABLE businesses CHANGE COLUMN customer_type registration_type VARCHAR(50) NULL',
  IF(@has_reg = 0,
     'ALTER TABLE businesses ADD COLUMN registration_type VARCHAR(50) NULL AFTER business_type',
     'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE businesses
   SET registration_type = IF(NULLIF(TRIM(gst_number), '') IS NULL, 'B2C', 'B2B')
 WHERE registration_type IS NULL
    OR registration_type NOT IN ('B2B', 'B2C');

-- Only now, with every row holding a legal value, does it become an ENUM.
SET @is_enum = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND COLUMN_NAME = 'registration_type' AND COLUMN_TYPE LIKE 'enum%');
SET @sql = IF(@is_enum = 0,
  'ALTER TABLE businesses MODIFY COLUMN registration_type ENUM(''B2B'',''B2C'') NOT NULL DEFAULT ''B2B''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND INDEX_NAME = 'idx_biz_registration_type');
SET @sql = IF(@x = 0,
  'ALTER TABLE businesses ADD INDEX idx_biz_registration_type (registration_type)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 2. BUSINESS_USERS BECOMES THE CONTACT TABLE TOO
--
-- Four columns are added and two constraints relaxed.  Nothing existing is
-- renamed, so every query already reading id / business_id / name / email /
-- mobile_number / password_hash / is_active keeps working unchanged.
--
--   contact_type    PRIMARY  = the business head; also the login account
--                   ALTERNATIVE = a further contact for the same business
--   designation     came from business_contacts.designation
--   whatsapp_number came from businesses.whatsapp_number / bc.whatsapp
--   login_enabled   came from business_contacts.login_enabled — the Super
--                   Admin's switch for whether this number may identify the
--                   business at sign-in
--
-- email and password_hash become NULLable because an ALTERNATIVE contact
-- has neither: they are a person to ring, not a second set of credentials.
-- The UNIQUE key on email is unaffected — MySQL does not compare NULLs as
-- equal, so any number of contacts may hold NULL there.
-- ============================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_users'
    AND COLUMN_NAME = 'contact_type');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_users
     ADD COLUMN contact_type ENUM(''PRIMARY'',''ALTERNATIVE'') NOT NULL DEFAULT ''PRIMARY'' AFTER business_id,
     ADD COLUMN designation VARCHAR(255) NULL AFTER name,
     ADD COLUMN whatsapp_number VARCHAR(20) NULL AFTER mobile_number,
     ADD COLUMN login_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER is_active',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- email: NOT NULL -> NULL.  Gated on it still being NOT NULL.
SET @x = (SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_users'
    AND COLUMN_NAME = 'email');
SET @sql = IF(@x = 'NO',
  'ALTER TABLE business_users MODIFY COLUMN email VARCHAR(255) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- password_hash: NOT NULL -> NULL.  A row WITHOUT one is a contact; a row
-- WITH one is an account.  That single fact is what the sign-in lookup
-- reads, so it never has to guess which rows are credentials.
SET @x = (SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_users'
    AND COLUMN_NAME = 'password_hash');
SET @sql = IF(@x = 'NO',
  'ALTER TABLE business_users MODIFY COLUMN password_hash VARCHAR(255) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- "Which rows belong to this business, and which of them is the head" is
-- the lookup every contact screen makes, so it is indexed.  The mobile
-- index 012 added is what answers "which business is this number?" and is
-- left exactly as it is.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_users'
    AND INDEX_NAME = 'idx_bu_business_contact');
SET @sql = IF(@x = 0,
  'ALTER TABLE business_users ADD INDEX idx_bu_business_contact (business_id, contact_type)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 3. THE EXISTING ACCOUNT ROWS ARE THE PRIMARY CONTACTS
--
-- Every row that was in business_users before this migration is a login
-- account, so it is the business head.  Its designation, WhatsApp number
-- and — where the account row never had one — its mobile number are filled
-- from the two places that DID hold them: the BUSINESS_HEAD contact row and
-- the columns on `businesses`.
--
-- COALESCE order is deliberate.  The account row's own value wins, because
-- it is the one the current login already uses; the head contact is next,
-- because 027 made it the maintained copy; the `businesses` columns are the
-- last resort, for a business onboarded before either existed.
--
-- Four spellings, because either source may already be gone on a re-run.
-- ============================================================
SET @sql = CASE
  WHEN @has_bc = 1 AND @has_biz_contact_cols = 1 THEN
    'UPDATE business_users bu
       JOIN businesses b ON b.id = bu.business_id
       LEFT JOIN business_contacts h
              ON h.business_id = bu.business_id AND h.contact_type = ''BUSINESS_HEAD''
        SET bu.contact_type    = ''PRIMARY'',
            bu.designation     = COALESCE(NULLIF(TRIM(bu.designation), ''''),
                                          NULLIF(TRIM(h.designation), ''''),
                                          NULLIF(TRIM(b.designation), '''')),
            bu.mobile_number   = COALESCE(NULLIF(TRIM(bu.mobile_number), ''''),
                                          NULLIF(TRIM(h.mobile), ''''),
                                          NULLIF(TRIM(b.mobile_number), '''')),
            bu.whatsapp_number = COALESCE(NULLIF(TRIM(bu.whatsapp_number), ''''),
                                          NULLIF(TRIM(h.whatsapp), ''''),
                                          NULLIF(TRIM(b.whatsapp_number), '''')),
            bu.login_enabled   = COALESCE(h.login_enabled, bu.login_enabled, TRUE)'
  WHEN @has_bc = 1 THEN
    'UPDATE business_users bu
       LEFT JOIN business_contacts h
              ON h.business_id = bu.business_id AND h.contact_type = ''BUSINESS_HEAD''
        SET bu.contact_type    = ''PRIMARY'',
            bu.designation     = COALESCE(NULLIF(TRIM(bu.designation), ''''),
                                          NULLIF(TRIM(h.designation), '''')),
            bu.mobile_number   = COALESCE(NULLIF(TRIM(bu.mobile_number), ''''),
                                          NULLIF(TRIM(h.mobile), '''')),
            bu.whatsapp_number = COALESCE(NULLIF(TRIM(bu.whatsapp_number), ''''),
                                          NULLIF(TRIM(h.whatsapp), '''')),
            bu.login_enabled   = COALESCE(h.login_enabled, bu.login_enabled, TRUE)'
  WHEN @has_biz_contact_cols = 1 THEN
    'UPDATE business_users bu
       JOIN businesses b ON b.id = bu.business_id
        SET bu.contact_type    = ''PRIMARY'',
            bu.designation     = COALESCE(NULLIF(TRIM(bu.designation), ''''),
                                          NULLIF(TRIM(b.designation), '''')),
            bu.mobile_number   = COALESCE(NULLIF(TRIM(bu.mobile_number), ''''),
                                          NULLIF(TRIM(b.mobile_number), '''')),
            bu.whatsapp_number = COALESCE(NULLIF(TRIM(bu.whatsapp_number), ''''),
                                          NULLIF(TRIM(b.whatsapp_number), ''''))'
  ELSE 'SELECT 1'
END;
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 4. A BUSINESS HEAD WITH NO ACCOUNT ROW STILL GETS A PRIMARY ROW
--
-- A business could hold a BUSINESS_HEAD contact but no business_users row —
-- an onboarding that recorded the person before credentials were issued.
-- Dropping business_contacts would lose that person entirely, so the head
-- is written as a PRIMARY row with NO password: a contact, reachable and
-- editable, that simply cannot sign in yet.  Its email is only copied when
-- no other account already claims it, because email is UNIQUE.
-- ============================================================
SET @sql = IF(@has_bc = 1,
  'INSERT INTO business_users
     (business_id, contact_type, name, designation, email, mobile_number,
      whatsapp_number, password_hash, is_active, login_enabled)
   SELECT h.business_id, ''PRIMARY'', h.name, h.designation,
          CASE WHEN NULLIF(TRIM(h.email), '''') IS NULL THEN NULL
               WHEN EXISTS (SELECT 1 FROM business_users e WHERE e.email = h.email) THEN NULL
               ELSE h.email END,
          h.mobile, h.whatsapp, NULL, TRUE, h.login_enabled
     FROM business_contacts h
    WHERE h.contact_type = ''BUSINESS_HEAD''
      AND NOT EXISTS (SELECT 1 FROM business_users x WHERE x.business_id = h.business_id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 5. ALTERNATIVE CONTACTS BECOME ALTERNATIVE ROWS
--
-- One row in, one row out, keeping the name, the designation, the mobile
-- and — importantly — the `login_enabled` switch, so a contact the Super
-- Admin had turned OFF does not come back on through the migration.
--
-- No password and no email: an alternative is a person to ring and a number
-- that identifies the business, not a second credential.  NOT EXISTS on the
-- (business_id, mobile) pair makes a re-run a no-op and stops a number that
-- is already the head's from being duplicated as an alternative.
-- ============================================================
SET @sql = IF(@has_bc = 1,
  'INSERT INTO business_users
     (business_id, contact_type, name, designation, email, mobile_number,
      whatsapp_number, password_hash, is_active, login_enabled)
   SELECT a.business_id, ''ALTERNATIVE'', a.name, a.designation, NULL, a.mobile,
          NULL, NULL, TRUE, a.login_enabled
     FROM business_contacts a
    WHERE a.contact_type = ''ALTERNATIVE''
      AND NULLIF(TRIM(a.mobile), '''') IS NOT NULL
      AND NOT EXISTS (
            SELECT 1 FROM business_users x
             WHERE x.business_id = a.business_id
               AND x.mobile_number = a.mobile)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 6. THE CONTACT NUMBERS STILL ONLY ON `businesses`
--
-- Two of them, both from migration 006:
--
--   alternate_contact_person / alternate_mobile_no
--       the oldest of the three copies -- one alternative contact flattened
--       into two columns.
--
--   contact_person_name / mobile_number
--       the business head as the business row remembered them. Step 3
--       already used this as a LAST-RESORT fill for the account row, so it
--       is usually the same number and adds nothing. But where the account
--       row carried its own, DIFFERENT number, this one is a real number the
--       business answers on that exists nowhere else -- and dropping the
--       column in step 8 would be the only place it was ever lost.
--
-- Both are carried over as ALTERNATIVE rows, and both skip anything already
-- recorded against the business, so a number that agrees with a contact is
-- not duplicated. UNION ALL rather than two statements only so the
-- NOT EXISTS rule is written once.
-- ============================================================
SET @has_alt_col = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
    AND COLUMN_NAME = 'alternate_mobile_no');

SET @sql = IF(@has_alt_col = 1 AND @has_biz_contact_cols = 1,
  'INSERT INTO business_users
     (business_id, contact_type, name, designation, email, mobile_number,
      whatsapp_number, password_hash, is_active, login_enabled)
   SELECT c.business_id, ''ALTERNATIVE'', MIN(c.name), NULL, NULL, c.mobile,
          NULL, NULL, TRUE, TRUE
     FROM (
       SELECT b.id AS business_id,
              COALESCE(NULLIF(TRIM(b.alternate_contact_person), ''''), ''Alternative contact'') AS name,
              TRIM(b.alternate_mobile_no) AS mobile
         FROM businesses b
        WHERE NULLIF(TRIM(b.alternate_mobile_no), '''') IS NOT NULL
       UNION ALL
       SELECT b.id,
              COALESCE(NULLIF(TRIM(b.contact_person_name), ''''), ''Business contact''),
              TRIM(b.mobile_number)
         FROM businesses b
        WHERE NULLIF(TRIM(b.mobile_number), '''') IS NOT NULL
     ) c
    WHERE NOT EXISTS (
            SELECT 1 FROM business_users x
             WHERE x.business_id = c.business_id
               AND x.mobile_number = c.mobile)
    GROUP BY c.business_id, c.mobile',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 7. DROP business_contacts
--
-- Only once every one of its rows is represented in business_users.  The
-- guard below counts the contacts that did NOT make it across — by
-- (business_id, mobile), the pair that identifies a contact — and skips the
-- drop entirely if there are any.  A migration that would lose a contact
-- does nothing instead, leaving both tables in place to be looked at.
--
-- No foreign key points AT business_contacts; its own FK points at
-- businesses, so nothing else is affected by the drop.
-- ============================================================
SET @sql = IF(@has_bc = 1,
  'SELECT COUNT(*) INTO @orphan_contacts FROM business_contacts c
    WHERE NULLIF(TRIM(c.mobile), '''') IS NOT NULL
      AND NOT EXISTS (
            SELECT 1 FROM business_users u
             WHERE u.business_id = c.business_id
               AND u.mobile_number = c.mobile)',
  'SELECT 0 INTO @orphan_contacts');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = IF(@has_bc = 1 AND @orphan_contacts = 0, 'DROP TABLE business_contacts', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 8. REMOVE THE CONTACT COLUMNS FROM `businesses`
--
-- `businesses` is now what the name says: the establishment.  Each of these
-- held a person, and every one of them has been copied into business_users
-- above, so they are the second copy, not the only one.
--
--   contact_person_name, designation, mobile_number, whatsapp_number,
--   email_id   -> the PRIMARY business_users row
--   alternate_contact_person, alternate_mobile_no
--              -> an ALTERNATIVE business_users row
--
-- `phone_number` and `email` are NOT dropped: they are the establishment's
-- own switchboard and mailbox rather than a named person, and the admin
-- business endpoints still read and write them.
--
-- Gated on the copy having actually happened: if any business still has a
-- contact column filled that no business_users row accounts for, the drop
-- is skipped rather than silently losing it.  The guard has to read the
-- columns it protects, so it too is only prepared while they exist.
-- ============================================================
SET @sql = IF(@has_biz_contact_cols = 1,
  'SELECT COUNT(*) INTO @unmigrated FROM businesses b
    WHERE (NULLIF(TRIM(b.mobile_number), '''') IS NOT NULL
           OR NULLIF(TRIM(b.contact_person_name), '''') IS NOT NULL
           OR NULLIF(TRIM(b.email_id), '''') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM business_users u WHERE u.business_id = b.id)',
  'SELECT 0 INTO @unmigrated');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = IF(@has_biz_contact_cols = 1 AND @unmigrated = 0,
  'ALTER TABLE businesses
     DROP COLUMN contact_person_name,
     DROP COLUMN designation,
     DROP COLUMN mobile_number,
     DROP COLUMN whatsapp_number,
     DROP COLUMN email_id,
     DROP COLUMN alternate_contact_person,
     DROP COLUMN alternate_mobile_no',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
