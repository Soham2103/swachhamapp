/**
 * Converts a business's "All services" price rows into per-service rows.
 *
 * WHAT IT IS FOR. `business_price_list` can hold a price two ways:
 *
 *   service_id NULL   the BASE RATE — applies to every service the item is
 *                     offered for, and is what the price list held before
 *                     migration 042 gave it a service column.
 *   service_id set    a price for ONE service type, which overrides the base.
 *
 * Both are supported everywhere and always have been. But a business still on
 * base rates cannot charge Dry Clean differently from Wash & Iron, because it
 * has one figure for both — and its price list reads as a flat list rather
 * than as the Wash & Fold / Wash & Iron / Dry Clean structure every other
 * business is managed under.
 *
 * This rewrites those base rates as explicit per-service rows.
 *
 * IT IS DELIBERATELY GENERIC. The business is an argument. There is no
 * per-business logic here and none anywhere else in the pricing path — the
 * screens, the import, the resolver and the order pricing are the same code
 * for every business, and this script does not add an exception to that.
 *
 * IT CHANGES NO PRICE. Each new row carries the base rate the item already
 * had, for each service that item is offered for. What the business is
 * charged today is exactly what it is charged afterwards; only the SHAPE of
 * the rows changes. That is what makes it safe to run on a live account —
 * and it is also why the Dry Clean rows it writes need a human afterwards:
 * they inherit the wash price, which is what the base rate was already
 * billing them at, not a Dry Clean price anyone chose.
 *
 * A row for a service that already has its own price is left alone, never
 * overwritten.
 *
 *   npx ts-node scripts/convert_prices_to_service_type.ts <businessId>
 *   npx ts-node scripts/convert_prices_to_service_type.ts <businessId> --apply
 *
 * Without --apply it only reports. With it, the whole conversion runs in one
 * transaction and prints the rows it removed so they can be put back.
 */
import dotenv from 'dotenv';
import { query, getClient } from '../src/config/database';
import { pool } from '../src/config/database';

dotenv.config();

interface BaseRow {
  id: number;
  item_id: number;
  item_name: string;
  laundry_type: 'hotel' | 'guest';
  price: string;
  is_active: number;
}

interface Plan {
  row: BaseRow;
  /** Services this item is offered for that have no price row of their own. */
  create: Array<{ id: number; name: string }>;
  /** Services already priced separately — left exactly as they are. */
  alreadyPriced: string[];
  /** Set when the item is offered for no active service at all. */
  blocked?: string;
}

async function main() {
  const businessId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!businessId || !/^\d+$/.test(businessId)) {
    console.log('Usage: npx ts-node scripts/convert_prices_to_service_type.ts <businessId> [--apply]');
    return;
  }

  const business = await query<{ id: number; name: string }>(
    `SELECT id, COALESCE(NULLIF(establishment_name,''), name) AS name
       FROM businesses WHERE id = ?`,
    [businessId]
  );
  if (business.rows.length === 0) {
    console.log(`No business with id ${businessId}.`);
    return;
  }
  console.log(`\n${business.rows[0].name} (#${businessId}) — ${apply ? 'APPLYING' : 'DRY RUN'}\n`);

  const base = await query<BaseRow>(
    `SELECT p.id, p.item_id, i.name AS item_name, p.laundry_type, p.price, p.is_active
       FROM business_price_list p
       JOIN services i ON i.id = p.item_id
      WHERE p.business_id = ? AND p.service_id IS NULL
      ORDER BY i.name`,
    [businessId]
  );

  if (base.rows.length === 0) {
    console.log('  Nothing to convert: this business has no "All services" rows.');
    return;
  }

  const plans: Plan[] = [];
  for (const row of base.rows) {
    // The services this item is actually offered for — the same predicate the
    // order screens and the import validator use.
    const offered = await query<{ id: number; name: string }>(
      `SELECT st.id, st.name
         FROM item_service_types m
         JOIN services st ON st.id = m.service_id
        WHERE m.item_id = ? AND st.kind = 'SERVICE_TYPE' AND st.is_active = 1
        ORDER BY st.name`,
      [row.item_id]
    );
    // Services that already carry their own price for this item and type.
    const taken = await query<{ service_id: number }>(
      `SELECT service_id FROM business_price_list
        WHERE business_id = ? AND item_id = ? AND laundry_type = ? AND service_id IS NOT NULL`,
      [businessId, row.item_id, row.laundry_type]
    );
    const takenIds = new Set(taken.rows.map((r) => Number(r.service_id)));

    const plan: Plan = {
      row,
      create: offered.rows.filter((s) => !takenIds.has(Number(s.id))),
      alreadyPriced: offered.rows.filter((s) => takenIds.has(Number(s.id))).map((s) => s.name),
    };
    if (offered.rows.length === 0) {
      plan.blocked = 'this item is offered for no active service type';
    }
    plans.push(plan);
  }

  let willCreate = 0;
  let willDelete = 0;
  const needsReview: string[] = [];

  for (const p of plans) {
    const parts: string[] = [];
    if (p.create.length > 0) parts.push(`create ${p.create.map((s) => s.name).join(', ')}`);
    if (p.alreadyPriced.length > 0) parts.push(`already priced: ${p.alreadyPriced.join(', ')}`);
    if (p.blocked) parts.push(`SKIPPED — ${p.blocked}`);
    console.log(
      `  ${p.row.item_name.padEnd(26)} ${String(p.row.price).padStart(8)}  ${p.row.laundry_type}` +
        `${p.row.is_active ? '' : ' (inactive)'}  ->  ${parts.join('; ')}`
    );
    if (!p.blocked) {
      willCreate += p.create.length;
      willDelete += 1;
      for (const s of p.create) {
        if (/dry\s*clean/i.test(s.name)) {
          needsReview.push(`${p.row.item_name} — Dry Clean at ${p.row.price}`);
        }
      }
    }
  }

  console.log(
    `\n  ${willCreate} per-service row(s) to create, ${willDelete} "All services" row(s) to remove.` +
      `${plans.some((p) => p.blocked) ? ' Skipped items keep their base rate.' : ''}`
  );

  if (needsReview.length > 0) {
    console.log(
      `\n  ${needsReview.length} DRY CLEAN row(s) would inherit the wash price — this is what the\n` +
        `  base rate already bills for a Dry Clean order, so nothing changes by writing it down,\n` +
        `  but a real Dry Clean price should be set on these afterwards:\n`
    );
    for (const line of needsReview) console.log(`    ${line}`);
  }

  if (!apply) {
    console.log('\n  DRY RUN — nothing was written. Re-run with --apply to make these changes.\n');
    return;
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();
    const removed: string[] = [];
    for (const p of plans) {
      if (p.blocked) continue;
      for (const service of p.create) {
        await connection.execute(
          `INSERT INTO business_price_list
             (business_id, item_id, laundry_type, service_id, price, is_active)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [businessId, p.row.item_id, p.row.laundry_type, service.id, p.row.price, p.row.is_active]
        );
      }
      await connection.execute(`DELETE FROM business_price_list WHERE id = ?`, [p.row.id]);
      removed.push(
        `INSERT INTO business_price_list (business_id,item_id,laundry_type,service_id,price,is_active) ` +
          `VALUES (${businessId},${p.row.item_id},'${p.row.laundry_type}',NULL,${p.row.price},${p.row.is_active});`
      );
    }
    await connection.commit();
    console.log(`\n  Applied. ${willCreate} row(s) created, ${willDelete} removed.`);
    console.log('\n  To restore the removed base rates, run:\n');
    for (const sql of removed) console.log(`    ${sql}`);
    console.log('');
  } catch (e: any) {
    await connection.rollback();
    console.log(`\n  FAILED, rolled back: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    connection.release();
  }
}

main()
  .catch((e) => {
    console.error('FAILED:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      /* already closed */
    }
  });
