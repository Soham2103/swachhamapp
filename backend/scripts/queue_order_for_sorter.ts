/**
 * Puts an order back into the Sorter's queue awaiting acceptance.
 *
 *   npx ts-node --transpile-only scripts/queue_order_for_sorter.ts
 *   npx ts-node --transpile-only scripts/queue_order_for_sorter.ts SWH#24082026000050
 *
 * Rewinds an order to ORDER_PLACED — the `confirmed` stage — so it appears in
 * the Sorter app for a human to accept. Accepting it there fires the rider
 * dispatch for real, which is the whole point: `make_live_rider_test.ts`
 * calls the acceptance itself, and this hands that step back to a person.
 *
 * It picks an order from a business that HAS a pickup point, because an
 * accepted order with no coordinates cannot be offered to any rider and the
 * test would stop dead at the interesting moment.
 *
 * Any rider job already attached is cleared, so the acceptance creates a
 * fresh one rather than finding the previous run's.
 */

import { pool, query } from '../src/config/database';
import { listOrders } from '../src/services/sorter.service';

async function main() {
  const wanted = process.argv[2];

  const orderResult = wanted
    ? await query<any>(
        `SELECT o.id, o.order_number, o.status, o.total_weight_kg
           FROM orders o WHERE o.order_number = ?`,
        [wanted]
      )
    : await query<any>(
        /*
         * The LIGHTEST order from a located business, not the newest.
         * The newest is the 105 kg one, which is a strange thing to hand a
         * rider on a bike while demonstrating the flow.
         */
        `SELECT o.id, o.order_number, o.status, o.total_weight_kg
           FROM orders o
           JOIN business_users bu ON bu.id = o.business_user_id
           JOIN businesses b      ON b.id = bu.business_id
          WHERE b.latitude IS NOT NULL AND b.longitude IS NOT NULL
            AND o.status <> 'CANCELLED'
          ORDER BY o.total_weight_kg ASC
          LIMIT 1`
      );

  const order = orderResult.rows[0];
  if (!order) {
    console.log('No suitable order found.');
    await pool.end();
    return;
  }

  const orderId = String(order.id);
  console.log('');
  console.log(`Order ${order.order_number} (${order.total_weight_kg} kg) is ${order.status}`);

  // Clear any previous run's job so the acceptance makes a clean one.
  const existing = await query<any>(`SELECT id FROM rider_jobs WHERE order_id = ?`, [orderId]);
  if (existing.rows.length > 0) {
    await query(
      `DELETE FROM rider_job_offers
        WHERE job_id IN (SELECT id FROM rider_jobs WHERE order_id = ?)`,
      [orderId]
    );
    await query(`DELETE FROM rider_jobs WHERE order_id = ?`, [orderId]);
    console.log(`  cleared ${existing.rows.length} existing rider job(s)`);
  }

  await query(`UPDATE orders SET status = 'ORDER_PLACED' WHERE id = ?`, [orderId]);
  await query(
    `UPDATE pickups
        SET status = 'SCHEDULED', picked_up_at = NULL, assigned_to = NULL, rider_job_id = NULL
      WHERE order_id = ?`,
    [orderId]
  );
  console.log('  set to ORDER_PLACED (the Sorter "confirmed" stage)');

  // ---- Prove it is actually in the queue the Sorter app reads ----
  const queue = await listOrders('confirmed');
  const inQueue = queue.orders.find((o) => String(o.id) === orderId);

  console.log('');
  console.log('Sorter queue counts:', JSON.stringify(queue.counts));
  console.log('');

  if (!inQueue) {
    console.log('  WARNING: the order is not showing in the confirmed queue.');
    await pool.end();
    return;
  }

  console.log('----------------------------------------------------');
  console.log('WAITING FOR THE SORTER');
  console.log(`  ${inQueue.order_number}`);
  console.log(`  ${inQueue.customer_name}  ${inQueue.customer_contact || ''}`);
  console.log(`  ${inQueue.item_count} line(s), ${inQueue.total_quantity} piece(s), ` +
    `${inQueue.total_weight_kg} kg`);
  console.log(`  stage: ${inQueue.stage}`);
  console.log('----------------------------------------------------');
  console.log('');
  console.log('In the Sorter app: open Requests, find this order, Accept it.');
  console.log('That fires the rider dispatch on its own — the pickup offer');
  console.log('should reach the rider phone within ~10 seconds.');
  console.log('');

  await pool.end();
}

main().catch(async (error) => {
  console.error('FAILED:', error);
  await pool.end();
  process.exit(1);
});
