/**
 * Fires a fresh pickup offer at the riders on duty, on demand.
 *
 *   npx ts-node --transpile-only scripts/dispatch_now.ts
 *   npx ts-node --transpile-only scripts/dispatch_now.ts SWH#24082026000051
 *
 * Offers lapse after 90 seconds, which is right for production and far too
 * short to sign into a phone against. This re-arms the job so a rider who is
 * already looking at the app gets a live card to accept.
 *
 * With no argument it takes the newest order belonging to a business that has
 * a pickup point on file.
 */

import { pool, query } from '../src/config/database';
import { createJobForOrder, dispatchJob } from '../src/services/dispatch.service';

async function main() {
  const wanted = process.argv[2];

  const orderResult = wanted
    ? await query<any>(
        `SELECT o.id, o.order_number, o.status FROM orders o WHERE o.order_number = ?`,
        [wanted]
      )
    : await query<any>(
        `SELECT o.id, o.order_number, o.status
           FROM orders o
           JOIN business_users bu ON bu.id = o.business_user_id
           JOIN businesses b      ON b.id = bu.business_id
          WHERE b.latitude IS NOT NULL
          ORDER BY o.id DESC LIMIT 1`
      );

  const order = orderResult.rows[0];
  if (!order) {
    console.log(wanted ? `No order ${wanted}.` : 'No order from a located business.');
    await pool.end();
    return;
  }

  const orderId = String(order.id);

  // Who is actually on duty right now, and where.
  const online = await query<any>(
    `SELECT u.name, u.mobile_number, rp.last_latitude, rp.last_longitude,
            TIMESTAMPDIFF(MINUTE, rp.last_location_at, NOW()) AS fix_age_min
       FROM rider_profiles rp JOIN users u ON u.id = rp.user_id
      WHERE rp.is_online = TRUE`
  );

  console.log(`\nOrder ${order.order_number} (${order.status})`);
  console.log(`Riders online: ${online.rows.length}`);
  for (const r of online.rows) {
    console.log(
      `  ${r.name} (${r.mobile_number}) at ${r.last_latitude}, ${r.last_longitude} ` +
        `— fix ${r.fix_age_min} min old`
    );
  }

  /*
   * A job already taken is not re-offered. Re-arming an ASSIGNED job would
   * pull it out from under the rider carrying it.
   */
  const existing = await query<any>(
    `SELECT id, status FROM rider_jobs WHERE order_id = ? AND job_type = 'PICKUP'`,
    [orderId]
  );

  if (existing.rows[0] && ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(existing.rows[0].status)) {
    console.log(
      `\nJob ${existing.rows[0].id} is already ${existing.rows[0].status} — not re-offering.\n`
    );
    await pool.end();
    return;
  }

  // Clear the previous round so every rider gets a fresh card.
  if (existing.rows[0]) {
    await query(`DELETE FROM rider_job_offers WHERE job_id = ?`, [existing.rows[0].id]);
    await query(
      `UPDATE rider_jobs SET status = 'PENDING', dispatch_attempts = 0 WHERE id = ?`,
      [existing.rows[0].id]
    );
  }

  const job = existing.rows[0]
    ? { id: String(existing.rows[0].id) }
    : await createJobForOrder(orderId, 'PICKUP');

  if (!job) {
    console.log('Could not create a job.\n');
    await pool.end();
    return;
  }

  const result = await dispatchJob(String(job.id));

  const detail = await query<any>(
    `SELECT handover_code FROM rider_jobs WHERE id = ?`,
    [job.id]
  );

  const offers = await query<any>(
    `SELECT u.name, u.mobile_number, rjo.distance_m, rjo.expires_at
       FROM rider_job_offers rjo JOIN users u ON u.id = rjo.rider_id
      WHERE rjo.job_id = ? AND rjo.status = 'OFFERED'
      ORDER BY rjo.distance_m ASC`,
    [job.id]
  );

  console.log(`\nOffered to ${result.offered} rider(s):`);
  for (const o of offers.rows) {
    console.log(`  ${o.name} (${o.mobile_number}) — ${o.distance_m} m`);
  }
  console.log(`\nHANDOVER CODE: ${detail.rows[0]?.handover_code}`);
  console.log(`Expires: ${offers.rows[0]?.expires_at || 'n/a'}\n`);

  await pool.end();
}

main().catch(async (error) => {
  console.error('FAILED:', error);
  await pool.end();
  process.exit(1);
});
