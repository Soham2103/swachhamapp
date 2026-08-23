-- ============================================================
-- SWACHHAM — Customer price list + Business price list
-- Migration: 025_price_lists.sql
--
-- Until now there was no price list at all. The only price in the
-- schema was `services.base_price`, a single NOT NULL column that
-- holds 0.00 / 1.00 placeholders across the whole catalogue. One
-- column cannot express "every business pays a different price for
-- the same item", so two relational tables are added.
--
-- Item identity is NOT duplicated. Both tables reference the item
-- rows that already exist -- services.id where kind = 'ITEM' -- so
-- there is exactly one record per item and the price lists hang off
-- it. `services.base_price` is left untouched; nothing reads it for
-- pricing any more, but historical rows keep their values.
--
--   customer_price_list   one row per item      -> the GLOBAL price
--                         UNIQUE (item_id)         every customer pays
--
--   business_price_list   one row per            -> that business's
--                         (business_id, item_id)    own price
--
-- The two are independent by construction: no trigger, view or
-- default copies one into the other, so changing a customer price
-- cannot move a business price and vice versa.
--
-- Soft delete: both tables carry is_active, matching the pattern the
-- rest of the schema already uses. A price is never hard-deleted by
-- the application, because order_items snapshots reference what was
-- charged and history must stay readable.
--
-- Idempotent, MySQL only. No drops, no deletes, no data rewritten.
-- ============================================================

-- ------------------------------------------------------------
-- CUSTOMER PRICE LIST — global, one price per item
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_price_list (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  item_id        BIGINT UNSIGNED NOT NULL,
  -- What the customer actually pays.
  customer_price DECIMAL(10,2) NOT NULL,
  -- The struck-through "was" price, when there is one. NULL means
  -- the item is simply priced, not discounted.
  original_price DECIMAL(10,2) NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer_item (item_id),
  INDEX idx_cpl_active (is_active),
  CONSTRAINT chk_cpl_price CHECK (customer_price >= 0),
  CONSTRAINT chk_cpl_original CHECK (original_price IS NULL OR original_price >= 0),
  CONSTRAINT fk_cpl_item FOREIGN KEY (item_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- BUSINESS PRICE LIST — per business, per item
--
-- The UNIQUE key is the whole point: a business can hold at most one
-- price for an item, so "which of the three rows is the real price"
-- can never come up. Two businesses holding different prices for the
-- same item is the normal case, not a conflict.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_price_list (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  item_id     BIGINT UNSIGNED NOT NULL,
  price       DECIMAL(10,2) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_business_item (business_id, item_id),
  INDEX idx_bpl_business (business_id),
  INDEX idx_bpl_item (item_id),
  INDEX idx_bpl_active (is_active),
  CONSTRAINT chk_bpl_price CHECK (price >= 0),
  CONSTRAINT fk_bpl_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT fk_bpl_item FOREIGN KEY (item_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- No seed.
--
-- Deliberately: `services.base_price` is 0.00 or 1.00 for every one
-- of the 128 catalogue items, so copying it in would give every
-- business a 1 rupee price list that looks configured but is not.
-- An unconfigured item is refused loudly at order time instead --
-- "No business price configured for this item." -- which is the
-- behaviour that keeps a wrong invoice from being generated.
-- ------------------------------------------------------------
