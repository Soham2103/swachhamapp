-- ============================================================
-- SWACHHAM — Rider module
-- Migration: 036_rider_module.sql
--
-- The pickup and delivery leg, which the schema had space for but no
-- machinery behind: `pickups` and `deliveries` have carried an
-- `assigned_to` column since the first schema and nothing ever set it,
-- and the orders enum has carried PICKUP_ASSIGNED / PICKED_UP /
-- DELIVERY_ASSIGNED / OUT_FOR_DELIVERY with nothing to move an order
-- through them.
--
-- What is added:
--
--   rider_profiles     One row per RIDER user: vehicle, duty state and
--                      last known position. Riders stay plain `users`
--                      rows — the role already exists — so this extends
--                      the account rather than replacing it.
--
--   rider_jobs         One leg of physical work: collect from a customer
--                      or business, or deliver back to them. Separate
--                      from `pickups`/`deliveries`, which are the
--                      CUSTOMER'S schedule (a date and a slot); this is
--                      the RIDER'S assignment, and the two answer
--                      different questions.
--
--   rider_job_offers   The dispatch fan-out. A job is offered to several
--                      nearby riders at once and the first to accept
--                      takes it; the rest are superseded. Keeping the
--                      offers as rows is what makes that auditable —
--                      who was asked, how far away they were, and who
--                      answered first.
--
-- Coordinates are DECIMAL(10,7), matching customer_addresses and
-- businesses, so distances compare without a cast.
--
-- Idempotent: every step is gated on information_schema. MySQL only.
-- ============================================================


-- ============================================================
-- 1. RIDER PROFILES
-- ============================================================
--
-- `is_online` is the rider's own duty switch; `active_job_count` is
-- derived state kept here so dispatch can filter on it in the same
-- query that filters on distance, instead of running a correlated
-- subquery per candidate rider.
--
-- The last known position lives on the profile rather than in a history
-- table. Dispatch only ever asks "where is this rider now", and a row
-- per ping per rider would grow without bound to answer a question
-- nobody asks. `last_location_at` is what makes a stale fix visible.
CREATE TABLE IF NOT EXISTS rider_profiles (
  user_id           BIGINT UNSIGNED PRIMARY KEY,
  vehicle_type      ENUM('BIKE','SCOOTER','CYCLE','VAN','OTHER') NOT NULL DEFAULT 'BIKE',
  vehicle_number    VARCHAR(20) NULL,
  license_number    VARCHAR(30) NULL,

  -- Duty state. A rider is only ever dispatched to while ONLINE.
  is_online         BOOLEAN NOT NULL DEFAULT FALSE,
  went_online_at    DATETIME NULL,

  -- Last known position. NULL until the first ping of a shift.
  last_latitude     DECIMAL(10,7) NULL,
  last_longitude    DECIMAL(10,7) NULL,
  last_accuracy_m   INT NULL,
  last_location_at  DATETIME NULL,

  -- How many jobs the rider is carrying, and the ceiling.
  active_job_count  INT NOT NULL DEFAULT 0,
  max_active_jobs   INT NOT NULL DEFAULT 3,

  -- Lifetime counters, for the rider's own summary screen.
  completed_jobs    INT NOT NULL DEFAULT 0,
  cancelled_jobs    INT NOT NULL DEFAULT 0,

  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Dispatch reads: online riders with spare capacity, then by distance.
  INDEX idx_rider_dispatch (is_online, active_job_count),
  INDEX idx_rider_location (last_latitude, last_longitude),
  CONSTRAINT fk_rider_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
-- 2. RIDER JOBS
-- ============================================================
--
-- The pickup or delivery leg of one order.
--
-- The destination is SNAPSHOTTED onto the job rather than joined at read
-- time. An order's address can be edited or deleted after the job is
-- created, and a rider halfway to a door must not have the door change
-- underneath them; the snapshot is also what lets a completed job still
-- explain itself a year later.
--
-- `handover_code` is a short code the customer or establishment reads
-- out to the rider, who enters it to close the job. It is what turns
-- "the rider says they collected it" into something the other party had
-- to agree to. Stored in clear on purpose: it confirms a physical
-- handover happening now, it is not a credential, and support has to be
-- able to read it back over the phone.
CREATE TABLE IF NOT EXISTS rider_jobs (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id          BIGINT UNSIGNED NOT NULL,
  job_type          ENUM('PICKUP','DELIVERY') NOT NULL,

  -- PENDING     created, not yet dispatched
  -- OFFERED     sitting with one or more nearby riders
  -- ASSIGNED    a rider accepted it
  -- EN_ROUTE    the rider started travelling
  -- ARRIVED     the rider is at the door
  -- COMPLETED   handover confirmed
  -- CANCELLED   called off
  -- UNASSIGNED  nobody accepted; needs a manual hand
  status            ENUM('PENDING','OFFERED','ASSIGNED','EN_ROUTE','ARRIVED','COMPLETED','CANCELLED','UNASSIGNED')
                      NOT NULL DEFAULT 'PENDING',

  rider_id          BIGINT UNSIGNED NULL,

  -- Where the rider is going, snapshotted at creation.
  latitude          DECIMAL(10,7) NULL,
  longitude         DECIMAL(10,7) NULL,
  address_text      TEXT NULL,
  contact_name      VARCHAR(255) NULL,
  contact_mobile    VARCHAR(20) NULL,

  handover_code     VARCHAR(6) NULL,

  -- Timeline. Each is set once, by the transition that earns it.
  dispatched_at     DATETIME NULL,
  assigned_at       DATETIME NULL,
  en_route_at       DATETIME NULL,
  arrived_at        DATETIME NULL,
  completed_at      DATETIME NULL,
  cancelled_at      DATETIME NULL,
  cancelled_reason  TEXT NULL,

  -- How many times dispatch has fanned this job out. A job nobody takes
  -- is retried, and this is what stops it being retried for ever.
  dispatch_attempts INT NOT NULL DEFAULT 0,

  rider_notes       TEXT NULL,
  proof_photo_url   VARCHAR(500) NULL,

  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- One pickup and one delivery per order, never two of either.
  UNIQUE KEY uk_rider_job_order_type (order_id, job_type),
  INDEX idx_rider_job_status (status, created_at),
  INDEX idx_rider_job_rider (rider_id, status),
  CONSTRAINT fk_rider_job_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_rider_job_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
-- 3. RIDER JOB OFFERS
-- ============================================================
--
-- One row per rider a job was offered to. The first ACCEPTED row wins
-- and every other offer on that job becomes SUPERSEDED, so the losing
-- riders can be told why the card vanished instead of it just going.
--
-- `distance_m` is recorded as it was AT OFFER TIME. Riders move, and the
-- reason a job went to this rider has to stay answerable afterwards.
CREATE TABLE IF NOT EXISTS rider_job_offers (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  job_id        BIGINT UNSIGNED NOT NULL,
  rider_id      BIGINT UNSIGNED NOT NULL,
  status        ENUM('OFFERED','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED') NOT NULL DEFAULT 'OFFERED',
  distance_m    INT NULL,
  offered_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NOT NULL,
  responded_at  DATETIME NULL,

  -- A rider is offered a given job once. A retry reuses the row rather
  -- than stacking a second card on the same phone.
  UNIQUE KEY uk_offer_job_rider (job_id, rider_id),
  INDEX idx_offer_rider_status (rider_id, status),
  INDEX idx_offer_expiry (status, expires_at),
  CONSTRAINT fk_offer_job FOREIGN KEY (job_id) REFERENCES rider_jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_offer_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
-- 4. NOTIFICATION TYPES FOR THE RIDER FLOW
-- ============================================================
--
-- APPENDED to whatever the column already lists, read live from
-- information_schema — the same reason the role enum is extended this
-- way in 017 and 020. Spelling the enum out by hand would drop any
-- value this database has that the migration files do not know about.
SET @curr = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type');
SET @sql = IF(@curr IS NOT NULL AND @curr NOT LIKE '%RIDER_JOB_OFFER%',
  CONCAT('ALTER TABLE notifications MODIFY COLUMN type ',
         LEFT(@curr, CHAR_LENGTH(@curr) - 1),
         ',''RIDER_JOB_OFFER'',''RIDER_JOB_ASSIGNED'',''RIDER_JOB_TAKEN'',',
         '''RIDER_NEARBY_ORDER'',''RIDER_ARRIVED'',''PICKUP_ASSIGNED'') ',
         'NOT NULL DEFAULT ''GENERAL'''),
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================
-- 5. PICKUPS / DELIVERIES — point at the rider job
-- ============================================================
--
-- The customer's schedule row and the rider's job stay separate, but
-- each pickup/delivery points at the job that fulfils it, so the
-- customer-facing screens can show a rider without knowing anything
-- about the dispatch model.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pickups' AND COLUMN_NAME = 'rider_job_id');
SET @sql = IF(@x = 0,
  'ALTER TABLE pickups ADD COLUMN rider_job_id BIGINT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveries' AND COLUMN_NAME = 'rider_job_id');
SET @sql = IF(@x = 0,
  'ALTER TABLE deliveries ADD COLUMN rider_job_id BIGINT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
