-- SWACHHAM — The central ticket system
-- Migration: 065_tickets.sql
--
-- ONE ticket system for the whole application. Every ticket a Sorter, a
-- Manager or a Business raises lives in `tickets`, and every reply in
-- `ticket_messages`. There is no second ticket table for any role, and no
-- role-specific variant of either.
--
-- WHAT ABOUT `rider_door_tickets`? It stays exactly where it is. It is not a
-- support ticket: it is a rider's at-the-door accept/reject question with its
-- own two-state lifecycle, raised and answered inside one delivery. Folding it
-- in would mean giving it a category, a priority, a resolver and a
-- conversation it has no use for. Nothing here touches it.
--
--
-- 1. WHY THE CREATOR IS TWO COLUMNS
--
-- Sorters and Managers are rows in `users`. Business users are rows in
-- `business_users` — a different table, with its own ids. A single
-- `created_by` could only point at one of them, so a ticket carries both and
-- fills exactly one. That is enforced in the SERVICE and not by a CHECK: MySQL
-- will not allow a CHECK over a column whose foreign key carries ON DELETE SET
-- NULL, and SET NULL is what lets a ticket outlive the account that raised it.
-- The constraint block below says more. `created_by_role` says which id to
-- read without having to test for NULL.
--
-- `created_by_name` is stored alongside, as the name read AT THE TIME. A
-- ticket is a record of who said what and when; renaming an account later must
-- not silently rewrite the history of a conversation.
--
--
-- 2. THE CATEGORIES ARE FIXED AND SHARED
--
-- One enum for all eight, not one per role. WHICH role may raise WHICH
-- category is a rule about people, not about storage, and it is enforced in
-- the service where it can produce a sentence explaining the refusal. Putting
-- it in the schema would mean a 403 arriving as a truncation error.
--
--
-- 3. STATUS HISTORY IS ITS OWN TABLE
--
-- `tickets.status` is where the ticket stands now; `ticket_status_history` is
-- every move it ever made, with who made it. The current status could be
-- derived from the history, and is stored anyway so the list query does not
-- need a correlated subquery per row.
--
--
-- 4. NOTHING CASCADES INTO NOTHING
--
-- The order and the business are ON DELETE SET NULL: a ticket is a record of a
-- complaint and must outlive the row it complains about. `order_number` and
-- the establishment name are stored beside the ids for the same reason — the
-- ticket still says what it was about after the order is gone.
--
-- Messages DO cascade from their ticket: a reply has no meaning without the
-- ticket it is a reply to.

CREATE TABLE IF NOT EXISTS tickets (
  id                          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  -- Human-facing identifier, e.g. SWT-000042. Assigned from the id inside the
  -- creating transaction, so it is unique without a second sequence table.
  ticket_number               VARCHAR(32) NOT NULL,

  -- All eight categories. The role that may raise each is enforced in code.
  category                    ENUM(
                                'QUANTITY_MISMATCHED',
                                'DAMAGE_ITEM',
                                'MATERIAL_REQUISITION',
                                'TECHNICAL_ISSUE',
                                'QUALITY_ISSUE',
                                'MISSING_ITEM',
                                'INVOICE_ISSUE',
                                'REWASH_REQUEST'
                              ) NOT NULL,

  title                       VARCHAR(200) NOT NULL,
  description                 TEXT NOT NULL,

  priority                    ENUM('LOW','MEDIUM','HIGH','URGENT')
                                NOT NULL DEFAULT 'MEDIUM',
  status                      ENUM('OPEN','IN_PROGRESS','WAITING_FOR_RESPONSE',
                                   'RESOLVED','CLOSED')
                                NOT NULL DEFAULT 'OPEN',

  -- WHO RAISED IT. Exactly one of the two ids; see note 1.
  created_by_user_id          BIGINT UNSIGNED NULL,
  created_by_business_user_id BIGINT UNSIGNED NULL,
  created_by_role             ENUM('SORTER','MANAGER','BUSINESS') NOT NULL,
  created_by_name             VARCHAR(150) NOT NULL,

  -- WHAT IT IS ABOUT. Both optional: a Material Requisition belongs to no
  -- order, and a Technical Issue to no establishment.
  business_id                 BIGINT UNSIGNED NULL,
  business_name               VARCHAR(255) NULL,
  order_id                    BIGINT UNSIGNED NULL,
  order_number                VARCHAR(30) NULL,

  -- WHO IS ANSWERING IT. Always a `users` row: only Managers and Super Admins
  -- ever resolve, and both live there.
  assigned_to_user_id         BIGINT UNSIGNED NULL,
  assigned_at                 DATETIME NULL,

  resolved_at                 DATETIME NULL,
  closed_at                   DATETIME NULL,
  created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_ticket_number (ticket_number),
  -- The list is filtered by status, priority, category, establishment, order
  -- and date; these cover the combinations the screens actually ask for.
  INDEX idx_ticket_status (status, created_at),
  INDEX idx_ticket_category (category, created_at),
  INDEX idx_ticket_business (business_id, created_at),
  INDEX idx_ticket_order (order_id),
  INDEX idx_ticket_creator_user (created_by_user_id, created_at),
  INDEX idx_ticket_creator_business (created_by_business_user_id, created_at),
  INDEX idx_ticket_assignee (assigned_to_user_id, status),

  CONSTRAINT fk_ticket_creator_user FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_creator_business FOREIGN KEY (created_by_business_user_id)
    REFERENCES business_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_business FOREIGN KEY (business_id)
    REFERENCES businesses(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_assignee FOREIGN KEY (assigned_to_user_id)
    REFERENCES users(id) ON DELETE SET NULL

  -- EXACTLY ONE CREATOR — enforced in the service, not by a CHECK here.
  --
  -- A CHECK was the obvious way to say it and MySQL refuses one: a column
  -- inside a CHECK may not also carry ON DELETE SET NULL, because the SET NULL
  -- would itself break the check. Deleting the account that raised a ticket
  -- would then be blocked, or would take the ticket with it.
  --
  -- SET NULL IS THE BEHAVIOUR WORTH KEEPING. A ticket is a record of a
  -- complaint and must outlive the account that made it — which is why
  -- `created_by_name` and `created_by_role` are stored on the row, so a ticket
  -- still says who raised it after the account is gone. A NULL id there means
  -- "that account no longer exists", not "no creator".
  --
  -- `createTicket` sets exactly one of the two and refuses to write a row with
  -- neither. See ticket.service.ts.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- THE CONVERSATION. One row per message, oldest first when read back. The
-- opening description is NOT duplicated here: it lives on the ticket, and a
-- copy would be a second version of the same text to keep in step.
CREATE TABLE IF NOT EXISTS ticket_messages (
  id                       BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ticket_id                BIGINT UNSIGNED NOT NULL,

  -- The same two-table sender as the ticket's creator, for the same reason.
  sender_user_id           BIGINT UNSIGNED NULL,
  sender_business_user_id  BIGINT UNSIGNED NULL,
  sender_role              ENUM('SORTER','MANAGER','BUSINESS','SUPER_ADMIN') NOT NULL,
  -- The name as it read when the message was sent. See note 1.
  sender_name              VARCHAR(150) NOT NULL,

  message                  TEXT NOT NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_tmsg_ticket (ticket_id, id),

  CONSTRAINT fk_tmsg_ticket FOREIGN KEY (ticket_id)
    REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_tmsg_sender_user FOREIGN KEY (sender_user_id)
    REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_tmsg_sender_business FOREIGN KEY (sender_business_user_id)
    REFERENCES business_users(id) ON DELETE SET NULL

  -- One sender, enforced in `reply` for the same reason as above: these two
  -- columns are ON DELETE SET NULL so a message survives its sender's account,
  -- and MySQL will not allow a CHECK over a column that does.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- EVERY MOVE THE TICKET EVER MADE. Append-only; nothing here is ever updated
-- or deleted, which is what makes it a history rather than a status field with
-- extra steps.
CREATE TABLE IF NOT EXISTS ticket_status_history (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ticket_id        BIGINT UNSIGNED NOT NULL,

  -- NULL on the opening row: the ticket came from nowhere into OPEN.
  previous_status  ENUM('OPEN','IN_PROGRESS','WAITING_FOR_RESPONSE',
                        'RESOLVED','CLOSED') NULL,
  new_status       ENUM('OPEN','IN_PROGRESS','WAITING_FOR_RESPONSE',
                        'RESOLVED','CLOSED') NOT NULL,

  changed_by_user_id BIGINT UNSIGNED NULL,
  changed_by_role    ENUM('SORTER','MANAGER','BUSINESS','SUPER_ADMIN') NOT NULL,
  changed_by_name    VARCHAR(150) NOT NULL,
  note               VARCHAR(500) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_tsh_ticket (ticket_id, id),
  CONSTRAINT fk_tsh_ticket FOREIGN KEY (ticket_id)
    REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_tsh_user FOREIGN KEY (changed_by_user_id)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
