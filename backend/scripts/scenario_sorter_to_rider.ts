/**
 * SCENARIO: Sorter accepts a pickup, a nearby rider gets it.
 *
 *   npx ts-node --transpile-only scripts/scenario_sorter_to_rider.ts
 *   npx ts-node --transpile-only scripts/scenario_sorter_to_rider.ts --check
 *   npx ts-node --transpile-only scripts/scenario_sorter_to_rider.ts \
 *     --rider 9000000011@17.7349759,73.1949048
 *
 * Sets the board up so the whole thing can be walked by hand, in the order a
 * person would actually do it: sign in as the Sorter, accept the order, then
 * sign in as the rider and work the job.
 *
 * WHAT IT PREPARES
 *   - one order rewound to ORDER_PLACED, waiting in the Sorter queue
 *   - any leftover rider job on that order cleared
 *   - optionally, riders placed at coordinates given with --rider
 *
 * WHAT IT DOES NOT DO
 *   It does not accept the order. That is the step being tested, and doing it
 *   here would prove nothing about the Sorter app.
 *
 * `--check` re-reads the state without changing anything, for looking at
 * what happened after the acceptance.
 */

import { pool, query } from '../src/config/database';
import { listOrders } from '../src/services/sorter.service';

/**
 * Rider positions are NOT hardcoded here.
 *
 * Baking somebody's test coordinates into a committed script leaves a set of
 * defaults that look authoritative and are not — the next person to run this
 * would silently teleport their riders to a spot chosen for one afternoon's
 * testing. Positions are supplied on the command line, or left alone.
 *
 *   --rider <mobile>@<lat>,<lng>    place this rider before setting up
 *
 * With none given the scenario only prepares the ORDER, and whatever
 * positions the riders already report are the ones that count — which is the
 * honest default, because in real use a rider's position comes from their
 * phone and from nowhere else.
 */
interface RiderPlacement {
  mobile: string;
  lat: number;
  lng: number;
}

function parseRiderArgs(): RiderPlacement[] {
  const placements: RiderPlacement[] = [];
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--rider') continue;
    const spec = args[i + 1];
    if (!spec) continue;

    const match = /^(\d{10})@(-?[\d.]+),(-?[\d.]+)$/.exec(spec);
    if (!match) {
      console.log(`  Ignoring --rider "${spec}" (expected <mobile>@<lat>,<lng>)`);
      continue;
    }
    placements.push({ mobile: match[1], lat: Number(match[2]), lng: Number(match[3]) });
  }

  return placements;
}

function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dy = (aLat - bLat) * 111320;
  const dx = (aLng - bLng) * 111320 * Math.cos((bLat * Math.PI) / 180);
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

function line() {
  console.log('--------------------------------------------------------');
}

/** Everything the scenario needs to talk about, read fresh. */
async function readState(orderNumber?: string) {
  const order = orderNumber
    ? await query<any>(
        `SELECT o.id, o.order_number, o.status, o.total_weight_kg,
                b.latitude, b.longitude,
                COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business
           FROM orders o
           JOIN business_users bu ON bu.id = o.business_user_id
           JOIN businesses b      ON b.id = bu.business_id
          WHERE o.order_number = ?`,
        [orderNumber]
      )
    : await query<any>(
        `SELECT o.id, o.order_number, o.status, o.total_weight_kg,
                b.latitude, b.longitude,
                COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business
           FROM orders o
           JOIN business_users bu ON bu.id = o.business_user_id
           JOIN businesses b      ON b.id = bu.business_id
          WHERE b.latitude IS NOT NULL AND o.status <> 'CANCELLED'
          ORDER BY o.total_weight_kg ASC LIMIT 1`
      );
  return order.rows[0];
}

async function reportJob(orderId: string) {
  const job = await query<any>(
    `SELECT id, status, handover_code, rider_id FROM rider_jobs
      WHERE order_id = ? AND job_type = 'PICKUP'`,
    [orderId]
  );
  if (job.rows.length === 0) {
    console.log('  Rider job: none yet (the Sorter has not accepted).');
    return;
  }
  const j = job.rows[0];
  console.log(`  Rider job ${j.id}: ${j.status}   handover code ${j.handover_code}`);

  const offers = await query<any>(
    `SELECT u.name, o.status, o.distance_m,
            GREATEST(TIMESTAMPDIFF(SECOND, NOW(), o.expires_at), 0) AS secs_left
       FROM rider_job_offers o JOIN users u ON u.id = o.rider_id
      WHERE o.job_id = ? ORDER BY o.distance_m ASC`,
    [j.id]
  );
  for (const o of offers.rows) {
    console.log(`    ${o.name}: ${o.status}, ${o.distance_m} m, ${o.secs_left}s left`);
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const explicit = process.argv.find((a) => a.startsWith('SWH'));

  const order = await readState(explicit);
  if (!order) {
    console.log('No order from a business with a pickup point. Set coordinates first.');
    await pool.end();
    return;
  }
  const orderId = String(order.id);
  const pLat = Number(order.latitude);
  const pLng = Number(order.longitude);

  if (checkOnly) {
    console.log('');
    line();
    console.log(`ORDER ${order.order_number} is ${order.status}`);
    await reportJob(orderId);
    line();
    console.log('');
    await pool.end();
    return;
  }

  // ---- 1. Rider positions, only if the caller asked for them ----
  const placements = parseRiderArgs();
  console.log('');
  if (placements.length === 0) {
    console.log('No --rider placements given; leaving rider positions as they are.');
    const online = await query<any>(
      `SELECT u.name, u.mobile_number, rp.last_latitude AS lat, rp.last_longitude AS lng,
              TIMESTAMPDIFF(MINUTE, rp.last_location_at, NOW()) AS fix_age_min
         FROM users u JOIN rider_profiles rp ON rp.user_id = u.id
        WHERE u.role = 'RIDER' AND rp.is_online = TRUE`
    );
    if (online.rows.length === 0) {
      console.log('  WARNING: nobody is online, so nothing can be dispatched.');
    }
    for (const r of online.rows) {
      const away =
        r.lat === null ? 'no position' : `${metresBetween(Number(r.lat), Number(r.lng), pLat, pLng)} m from pickup`;
      console.log(`  ${r.name} (${r.mobile_number}) online, ${away}, fix ${r.fix_age_min} min old`);
    }
  } else {
    console.log('Placing riders...');
    for (const r of placements) {
      const user = await query<any>(
        `SELECT id, name FROM users WHERE mobile_number = ? AND role = 'RIDER'`,
        [r.mobile]
      );
      if (user.rows.length === 0) {
        console.log(`  ${r.mobile} is not a rider account - skipped`);
        continue;
      }
      const id = String(user.rows[0].id);
      await query(`INSERT IGNORE INTO rider_profiles (user_id) VALUES (?)`, [id]);
      await query(
        `UPDATE rider_profiles
            SET is_online = TRUE, went_online_at = COALESCE(went_online_at, NOW()),
                last_latitude = ?, last_longitude = ?, last_accuracy_m = 10,
                last_location_at = NOW()
          WHERE user_id = ?`,
        [r.lat, r.lng, id]
      );
      console.log(
        `  ${user.rows[0].name} (${r.mobile}) online, ` +
          `${metresBetween(r.lat, r.lng, pLat, pLng)} m from pickup`
      );
    }
  }

  // ---- 2. The order back into the Sorter queue ----
  console.log('');
  console.log('Setting up the order...');
  const existing = await query<any>(`SELECT id FROM rider_jobs WHERE order_id = ?`, [orderId]);
  if (existing.rows.length > 0) {
    await query(
      `DELETE FROM rider_job_offers
        WHERE job_id IN (SELECT id FROM rider_jobs WHERE order_id = ?)`,
      [orderId]
    );
    await query(`DELETE FROM rider_jobs WHERE order_id = ?`, [orderId]);
    console.log(`  cleared ${existing.rows.length} leftover rider job(s)`);
  }
  await query(`UPDATE orders SET status = 'ORDER_PLACED' WHERE id = ?`, [orderId]);
  await query(
    `UPDATE pickups SET status = 'SCHEDULED', picked_up_at = NULL, assigned_to = NULL,
            rider_job_id = NULL WHERE order_id = ?`,
    [orderId]
  );
  console.log(`  ${order.order_number} rewound to ORDER_PLACED`);

  // Prove it is in the queue the Sorter app actually reads.
  const queue = await listOrders('confirmed');
  const inQueue = queue.orders.find((o) => String(o.id) === orderId);
  console.log(`  showing in the Sorter confirmed queue: ${inQueue ? 'YES' : 'NO'}`);

  // ---- 3. The script ----
  console.log('');
  line();
  console.log('SCENARIO READY');
  line();
  console.log(`Order    ${order.order_number}  (${order.total_weight_kg} kg)`);
  console.log(`Pickup   ${order.business} at ${pLat}, ${pLng}`);
  console.log('');
  console.log('STEP 1 - SIGN IN AS A SORTER');
  console.log(`  Open Requests, find ${order.order_number}, tap Accept.`);
  console.log('  Accepting fires the rider dispatch by itself.');
  console.log('');
  console.log('STEP 2 - SIGN OUT, SIGN IN AS A RIDER');
  console.log('  The offer is waiting on the dashboard (~10s poll).');
  console.log('');
  console.log('STEP 3 - WORK THE JOB');
  console.log('  Accept  ->  Start (Google Maps opens)  ->  I have arrived');
  console.log('  ->  enter the handover code  ->  Drop off at facility');
  console.log('');
  console.log('The handover code is printed by:');
  console.log('  npx ts-node --transpile-only scripts/scenario_sorter_to_rider.ts --check');
  line();
  console.log('');
  console.log('An offer lapses after RIDER_OFFER_TTL_SECONDS (default 90), which is');
  console.log('short for switching accounts by hand - raise it in backend/.env while');
  console.log('testing, and put it back afterwards.');
  console.log('');

  await pool.end();
}

main().catch(async (error) => {
  console.error('FAILED:', error);
  await pool.end();
  process.exit(1);
});
