/**
 * Verification for `orders.placed_by_mobile`.
 *
 * READ-ONLY. It runs SELECTs and nothing else — no order is created, none is
 * modified, and no historical NULL is backfilled. That last point is the whole
 * reason this is a report rather than a migration: for an order placed before
 * the column existed, which number the person actually used was never
 * recorded, and there is nothing in the order, the OTP table or the customer
 * record that can recover it. Substituting the business's or the customer's
 * primary number would not be a backfill, it would be an invention, so those
 * rows stay NULL and every document prints "N/A" for them.
 *
 *   npx ts-node scripts/verify_placed_by_mobile.ts
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';

dotenv.config();

/** The column exists, and orders can be read. */
async function main() {
  const column = await query<any>(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
        AND COLUMN_NAME = 'placed_by_mobile'`
  );
  if (column.rows.length === 0) {
    console.log('FAIL  orders.placed_by_mobile does not exist.');
    console.log('      Run database/migrations/032_order_mobile_and_payment_receipts.sql');
    return;
  }
  const meta = column.rows[0];
  console.log(`orders.placed_by_mobile  ${meta.COLUMN_TYPE}  nullable=${meta.IS_NULLABLE}`);

  /* ================================================================
   * THE QUERY THE REQUIREMENT ASKS FOR
   * ================================================================ */
  console.log('\nSELECT id, placed_by_mobile FROM orders ORDER BY created_at DESC (25 newest)');
  const recent = await query<any>(
    `SELECT o.id, o.order_number, o.placed_by_mobile, o.created_at,
            CASE WHEN o.business_user_id IS NOT NULL THEN 'BUSINESS' ELSE 'CUSTOMER' END AS placed_as,
            bu.mobile_number AS account_mobile,
            u.mobile_number  AS customer_mobile
       FROM orders o
       LEFT JOIN business_users bu ON bu.id = o.business_user_id
       LEFT JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 25`
  );
  for (const r of recent.rows) {
    const own = r.placed_as === 'BUSINESS' ? r.account_mobile : r.customer_mobile;
    // Says so explicitly when the two differ: that is the alternative-contact
    // case, and it is the case this whole change exists for.
    const note =
      r.placed_by_mobile === null
        ? '(NULL — placed before the field existed; documents show N/A)'
        : own && String(own) !== String(r.placed_by_mobile)
          ? `(differs from the account's ${own} — an alternative number was verified)`
          : '';
    console.log(
      `  #${String(r.id).padEnd(7)} ${String(r.order_number || '').padEnd(22)} ` +
      `${String(r.placed_by_mobile ?? 'NULL').padEnd(12)} ${r.placed_as.padEnd(8)} ${note}`
    );
  }

  /* ================================================================
   * THE SHAPE OF THE WHOLE TABLE
   * ================================================================ */
  const totals = await query<any>(
    `SELECT COUNT(*) AS total,
            SUM(placed_by_mobile IS NULL) AS nulls,
            SUM(placed_by_mobile IS NOT NULL) AS populated
       FROM orders`
  );
  const t = totals.rows[0];
  console.log(
    `\n${t.total} order(s): ${t.populated} carry a number, ${t.nulls} are NULL (historical).`
  );

  /*
   * MALFORMED VALUES. The writer normalises to ten digits or stores NULL, so
   * anything else in here would mean something wrote the column directly.
   */
  const malformed = await query<any>(
    `SELECT COUNT(*) AS n FROM orders
      WHERE placed_by_mobile IS NOT NULL
        AND placed_by_mobile NOT REGEXP '^[6-9][0-9]{9}$'`
  );
  console.log(
    Number(malformed.rows[0].n) === 0
      ? 'PASS  every stored number is a well-formed 10-digit mobile.'
      : `FAIL  ${malformed.rows[0].n} order(s) hold a malformed number.`
  );

  /*
   * ORDERS PLACED ON A NUMBER THAT IS NOT THE ACCOUNT'S.
   *
   * The alternative-contact case, counted. A business is reached on its
   * primary contact's number and up to three alternatives', any of which may
   * sign in; when one of the alternatives did, the order says so, and this is
   * where that shows up. Zero here is not a failure — it only means no order
   * yet was placed on an alternative number.
   */
  const alternates = await query<any>(
    `SELECT COUNT(*) AS n
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE o.placed_by_mobile IS NOT NULL
        AND o.placed_by_mobile <> bu.mobile_number`
  );
  console.log(
    `      ${alternates.rows[0].n} business order(s) were placed on a number other ` +
    `than the account's own.`
  );

  /*
   * AND THAT EVERY NUMBER STORED IS ONE THE BUSINESS ACTUALLY ANSWERS ON.
   *
   * Every contact of a business — primary and alternative alike — is a row in
   * `business_users`, so a number on one of its orders must match one of them.
   * Anything else would mean an order was stamped with a number nobody proved.
   */
  const unknown = await query<any>(
    `SELECT o.id, o.order_number, o.placed_by_mobile
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE o.placed_by_mobile IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM business_users c
           WHERE c.business_id = bu.business_id
             AND c.mobile_number = o.placed_by_mobile)`
  );
  if (unknown.rows.length === 0) {
    console.log("PASS  every business order's number is one of that business's own contacts.");
  } else {
    console.log(`WARN  ${unknown.rows.length} business order(s) carry a number that is not a`);
    console.log('      current contact of the business. That is expected only where a contact');
    console.log('      was changed or removed AFTER the order — the order keeps what it was');
    console.log('      placed on, which is the point of the snapshot.');
    for (const r of unknown.rows.slice(0, 10)) {
      console.log(`        #${r.id} ${r.order_number} ${r.placed_by_mobile}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
