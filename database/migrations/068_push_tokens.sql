-- ============================================================
-- SWACHHAM — Firebase Cloud Messaging device tokens
-- Migration: 068_push_tokens.sql
--
-- WHY THIS TABLE EXISTS
--
-- The handover code, and every other notification worth acting on
-- immediately, already reaches its recipient: a customer gets a
-- `notifications` row, an establishment gets a `business_messages`
-- row. Both are DURABLE and both require somebody to open a screen
-- and look. A rider standing at a hotel door needs the code now, so
-- the message has to reach the phone rather than wait on it.
--
-- FCM addresses a DEVICE, not an account, so the mapping from an
-- account to its devices has to be stored. That is all this is.
--
-- TWO KINDS OF OWNER, ONE PER ROW
--
-- A customer is a `users` row; an establishment's login is a
-- `business_users` row. They are different tables — the same reason
-- `notifications` cannot hold a business message — so a token
-- carries one of the two and never both. The CHECK constraint makes
-- "exactly one" a rule the database keeps rather than a convention
-- the application remembers.
--
-- THE TOKEN IS THE IDENTITY
--
-- `token` is UNIQUE. FCM reissues the same string to the same app
-- install, and one device may be signed out of one account and into
-- another — so registering an existing token REASSIGNS it rather
-- than creating a second row, and the old owner stops receiving
-- that device's pushes. Without the unique key a shared handset
-- would keep delivering one user's notifications to the next.
--
-- NOTHING SECRET IS HELD HERE. An FCM registration token lets a
-- server send TO a device; it does not authenticate anyone and
-- cannot read anything.
--
-- Idempotent: safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_tokens (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  -- Exactly one of these is set; see the CHECK below.
  user_id          BIGINT UNSIGNED NULL,
  business_user_id BIGINT UNSIGNED NULL,

  -- The FCM registration token. 512 is comfortably above the ~163
  -- characters FCM issues today, with room for a longer future form.
  token            VARCHAR(512) NOT NULL,

  platform         ENUM('android','ios','web') NOT NULL DEFAULT 'android',

  /*
   * Kept for support, not for logic. When a hotel says "it stopped
   * buzzing", the useful question is which handset last checked in.
   */
  device_name      VARCHAR(120) NULL,

  /*
   * Refreshed every time the app re-registers, which it does on each
   * sign-in and whenever FCM rotates the token. A token that has not
   * been seen for a long time is a device that no longer runs the app.
   */
  last_seen_at     DATETIME NULL,

  /*
   * Set to FALSE when FCM answers `registration-token-not-registered`
   * — the app was uninstalled, or the token was replaced. The row is
   * kept rather than deleted so a device that returns is recognised
   * instead of silently duplicated.
   */
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,

  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_push_token (token),
  INDEX idx_push_user (user_id, is_active),
  INDEX idx_push_business_user (business_user_id, is_active),

  CONSTRAINT fk_push_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_push_business_user FOREIGN KEY (business_user_id)
    REFERENCES business_users(id) ON DELETE CASCADE,

  -- One owner per row, enforced here so no code path can write a
  -- token that belongs to nobody or to two accounts at once.
  CONSTRAINT chk_push_one_owner CHECK (
    (user_id IS NOT NULL AND business_user_id IS NULL) OR
    (user_id IS NULL AND business_user_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
