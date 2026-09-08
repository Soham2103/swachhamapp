-- SWACHHAM — Sorter: the per-item cloth counts
-- Migration: 060_pending_item_cloth_counts.sql
--
-- The cloth counts the Sorter takes are counted PER LINE, not per order: each
-- item on an order is counted on its own, so each one carries its own record
-- here.
--
-- WHY order_number AND business_name ARE STORED ON THE ROW.
--
-- Both are reachable by joining `orders` and `businesses`, and both are stored
-- anyway. This table is the source for a document that is read on the shop
-- floor and away from it, and a row that carries the order it belongs to and
-- the establishment it was taken for explains itself without a join — the same
-- reason `order_item_adjustments` repeats `original_quantity` on every row.
-- `order_id` and `order_item_id` remain the real links; the two names are a
-- record of what they were called when the count was taken.
--
-- ONE ROW PER LINE, enforced by the unique key on order_item_id rather than
-- by the code that writes it. An item is counted once and re-counted in place;
-- a second count corrects the first instead of adding to it. An order_item
-- belongs to exactly one order, so that key alone is enough.
--
-- NULLABLE COUNTS, and NULL means "not counted" — a different fact from 0,
-- "counted, and there were none". A row exists as soon as any one of the three
-- is entered, and the two not entered stay NULL rather than becoming zeroes
-- nobody counted.
--
-- CASCADE ON DELETE for both keys: these counts describe a line of an order,
-- and they have no meaning once the line or the order is gone.
--
-- Guarded with CREATE TABLE IF NOT EXISTS because the runner replays every
-- migration on each run, so a second run must be a no-op.

CREATE TABLE IF NOT EXISTS pending_item (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  -- The links. These are what the data actually hangs from.
  order_id            BIGINT UNSIGNED NOT NULL,
  order_item_id       BIGINT UNSIGNED NOT NULL,

  -- The names, as they read when the count was taken. See the note above.
  order_number        VARCHAR(30)  NOT NULL,
  business_name       VARCHAR(255) NOT NULL,
  item_name           VARCHAR(255) NOT NULL,

  -- The three counts. NULL is "not counted"; 0 is "counted, none".
  white_cloth_count   INT UNSIGNED NULL,
  color_cloth_count   INT UNSIGNED NULL,
  socked_cloth_count  INT UNSIGNED NULL,

  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

  -- One count per line, as a constraint and not a convention.
  UNIQUE KEY uq_pending_item_line (order_item_id),
  -- The document reads every line of one order, in insertion order.
  INDEX idx_pending_item_order (order_id, id),

  CONSTRAINT fk_pending_item_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_pending_item_item FOREIGN KEY (order_item_id)
    REFERENCES order_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
