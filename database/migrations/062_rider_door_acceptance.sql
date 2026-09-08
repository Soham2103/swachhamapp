-- ============================================================
-- SWACHHAM — Rider door acceptance: counted vs uncounted
-- Migration: 062_rider_door_acceptance.sql
--
-- Idempotent. MySQL 8. No table dropped, no row deleted, no
-- existing column altered, and no existing order's status
-- changed. Everything here is NEW and ADDITIVE.
-- ============================================================
--
--
-- 1. WHAT THIS IS FOR
--
-- A rider standing at a hotel's door either counted the load
-- with the hotel's staff or did not. Those are two different
-- promises about what was collected, and until now the app had
-- no way to record which one happened — a rider simply accepted
-- the job.
--
-- The rider now picks one at acceptance:
--
--   WITH_COUNT     counted and checked at the door. The hotel is
--                  told so, and the job proceeds immediately.
--   WITHOUT_COUNT  not counted. This RAISES A TICKET the hotel
--                  must accept before the rider proceeds, because
--                  the hotel is agreeing to a load nobody agreed
--                  the contents of.
--
--
-- 2. WHY A TICKET TABLE AND NOT AN ORDER COLUMN
--
-- The uncounted case is a CONVERSATION with two ends — the rider
-- raises it, the hotel answers it — and it has a state that
-- outlives a single request: PENDING until the hotel accepts.
-- A column on `orders` could hold the final answer but not the
-- waiting, and the rider's phone has to poll something to learn
-- the answer arrived (the app has NO SOCKET CLIENT —
-- `socket.io-client` is not a dependency, so a server-side emit
-- reaches nothing).
--
-- One row per JOB, not per order. The unique key on `job_id` is
-- what makes raising a ticket idempotent: a rider who taps twice,
-- or whose request is retried, gets the same ticket back rather
-- than a second one for the hotel to answer.
--
--
-- 3. WHY BUSINESS MESSAGES ARE A SEPARATE TABLE FROM `notifications`
--
-- THIS IS NOT A DUPLICATE OF `notifications`. That table cannot
-- hold these rows: `notifications.user_id` is a foreign key to
-- `users`, and a hotel account lives in `business_users`, which
-- is a DIFFERENT TABLE with its own id space. Writing a hotel's
-- id into `notifications.user_id` would either fail the foreign
-- key or, worse, silently address the row to whichever `users`
-- row happens to share that number.
--
-- `rider.service.notifyOrderParty` already documents this exact
-- limitation and works around it by emitting on a socket for
-- business orders — which, per section 2, nothing in the app
-- receives. So a hotel has never actually been reachable. This
-- table is the durable channel it was missing, and the messages
-- the brief requires are the first things to use it.
--
-- Deliberately NOT a general chat: there is no `from` and no
-- reply. It is a one-way record of what the rider's app told the
-- hotel, which is all the two required messages need.
-- ============================================================


-- ---- The ticket a rider raises when the load was not counted ----
CREATE TABLE IF NOT EXISTS rider_door_tickets (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id          BIGINT UNSIGNED NOT NULL,
  job_id            BIGINT UNSIGNED NOT NULL,
  rider_id          BIGINT UNSIGNED NOT NULL,

  -- The hotel account that must answer. Resolved from
  -- `orders.business_user_id` when the ticket is raised, and
  -- stored so the queue does not have to re-join to `orders`.
  business_user_id  BIGINT UNSIGNED NOT NULL,

  -- PENDING   raised, the hotel has not answered
  -- ACCEPTED  the hotel agreed; the rider may proceed
  --
  -- There is no REJECTED. The brief gives the hotel one answer to
  -- give, and a rider standing at the door with the bags needs a
  -- way forward, not a dead end. If refusal is ever wanted it is a
  -- new value here plus a branch in the service — not a rewrite.
  status            ENUM('PENDING','ACCEPTED') NOT NULL DEFAULT 'PENDING',

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at       DATETIME NULL,

  -- One ticket per job. This is what makes raising idempotent —
  -- see section 2.
  UNIQUE KEY uk_door_ticket_job (job_id),

  -- The hotel's queue: its own PENDING tickets, newest first.
  INDEX idx_door_ticket_business_status (business_user_id, status, created_at),

  -- The rider's poll while waiting.
  INDEX idx_door_ticket_rider_status (rider_id, status),

  CONSTRAINT fk_door_ticket_order
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_door_ticket_job
    FOREIGN KEY (job_id) REFERENCES rider_jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_door_ticket_rider
    FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_door_ticket_business_user
    FOREIGN KEY (business_user_id) REFERENCES business_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- Durable messages addressed to a hotel account ----
CREATE TABLE IF NOT EXISTS business_messages (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  business_user_id  BIGINT UNSIGNED NOT NULL,

  -- Both nullable so a message can outlive what it refers to
  -- (ON DELETE SET NULL below) rather than vanishing from the
  -- hotel's history with it.
  order_id          BIGINT UNSIGNED NULL,
  ticket_id         BIGINT UNSIGNED NULL,

  -- A short machine tag beside the human text, so a later reader
  -- can find these without matching on the sentence itself.
  --   DOOR_CHECKED           "Order is checked at door"
  --   DOOR_UNCOUNTED_AGREED  the post-acceptance mismatch notice
  type              VARCHAR(64) NOT NULL,
  body              TEXT NOT NULL,

  is_read           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_bmsg_business_created (business_user_id, created_at),
  INDEX idx_bmsg_business_unread (business_user_id, is_read),

  CONSTRAINT fk_bmsg_business_user
    FOREIGN KEY (business_user_id) REFERENCES business_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_bmsg_order
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_bmsg_ticket
    FOREIGN KEY (ticket_id) REFERENCES rider_door_tickets(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---- rider_jobs.door_acceptance_mode ----
--
-- WHICH WAY the rider accepted, kept on the job itself so the
-- record survives independently of the ticket (a WITH_COUNT
-- acceptance raises no ticket at all, so the tickets table alone
-- cannot answer "how was this accepted").
--
-- NULL for every job accepted before this migration and for every
-- job accepted through a client that does not send a mode. That
-- is deliberate: NULL means "not recorded", which is the truth
-- about those rows, and is distinguishable from either choice.
SET @sql := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'rider_jobs'
              AND COLUMN_NAME = 'door_acceptance_mode'),
    'SELECT ''rider_jobs.door_acceptance_mode already exists''',
    'ALTER TABLE rider_jobs
       ADD COLUMN door_acceptance_mode ENUM(''WITH_COUNT'',''WITHOUT_COUNT'') NULL
         COMMENT ''How the rider accepted at the door. NULL = not recorded.''
       AFTER rider_id'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
