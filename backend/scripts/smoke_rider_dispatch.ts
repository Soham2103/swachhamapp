/**
 * End-to-end smoke test for the rider module.
 *
 *   npx ts-node scripts/smoke_rider_dispatch.ts
 *
 * Walks the whole path the business described, against the real database:
 *
 *   order exists -> job created -> offered to the nearest online rider
 *                -> accepted (and a second rider loses the race)
 *                -> en route -> arrived -> handover code -> completed
 *
 * WHAT IT TOUCHES. It creates two throwaway rider accounts (mobile numbers
 * 9000000001/2, role RIDER) and one rider job against the newest order. If
 * that order's business has no coordinates -- which today every business in
 * this database lacks -- it stamps a temporary pickup point so the distance
 * matching has something to match on.
 *
 * Everything it creates or changes is put back at the end: the riders, the
 * job and its offers, the order's status and history rows, and the fixture
 * coordinates. A run leaves the database exactly as it found it.
 */

import { pool, query } from '../src/config/database';
import {
  createJobForOrder,
  dispatchJob,
  acceptJob,
} from '../src/services/dispatch.service';
import {
  setOnlineStatus,
  updateJobStatus,
  completeJob,
  dropAtFacility,
  getOrCreateProfile,
} from '../src/services/rider.service';

const RIDER_A_MOBILE = '9000000001';
const RIDER_B_MOBILE = '9000000002';

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A throwaway RIDER user, reused across runs so repeats stay clean. */
async function ensureRider(mobile: string, name: string): Promise<string> {
  const existing = await query<any>(`SELECT id FROM users WHERE mobile_number = ?`, [mobile]);
  if (existing.rows.length > 0) return String(existing.rows[0].id);

  const inserted = await query(
    `INSERT INTO users (name, mobile_number, role, is_active, mobile_verified)
     VALUES (?, ?, 'RIDER', TRUE, TRUE)`,
    [name, mobile]
  );
  return String(inserted.insertId);
}

async function cleanup(riderIds: string[], jobId?: string, orderId?: string, prevStatus?: string) {
  if (jobId) {
    await query(`DELETE FROM rider_job_offers WHERE job_id = ?`, [jobId]);
    await query(`DELETE FROM rider_jobs WHERE id = ?`, [jobId]);
  }
  if (orderId && prevStatus) {
    await query(`UPDATE orders SET status = ? WHERE id = ?`, [prevStatus, orderId]);
    await query(
      `DELETE FROM order_status_history
        WHERE order_id = ? AND changed_by IN (${riderIds.map(() => '?').join(',')})`,
      [orderId, ...riderIds]
    );
  }
  for (const id of riderIds) {
    await query(`DELETE FROM rider_profiles WHERE user_id = ?`, [id]);
    await query(`DELETE FROM notifications WHERE user_id = ?`, [id]);
    await query(`DELETE FROM users WHERE id = ?`, [id]);
  }
}

async function main() {
  console.log('\n=== RIDER DISPATCH SMOKE TEST ===\n');

  // ---- An order with coordinates to work with ----
  const orderResult = await query<any>(
    `SELECT o.id, o.order_number, o.status, bu.business_id,
            COALESCE(ca.latitude, b.latitude)   AS lat,
            COALESCE(ca.longitude, b.longitude) AS lng
       FROM orders o
       LEFT JOIN customer_addresses ca ON ca.id = o.address_id
       LEFT JOIN business_users bu     ON bu.id = o.business_user_id
       LEFT JOIN businesses b          ON b.id = bu.business_id
      ORDER BY o.id DESC
      LIMIT 1`
  );

  if (orderResult.rows.length === 0) {
    console.log('  SKIP  No orders exist yet - place one first.');
    await pool.end();
    return;
  }

  const order = orderResult.rows[0];
  const orderId = String(order.id);
  const prevStatus = order.status;

  /*
   * A PICKUP POINT TO TEST AGAINST.
   *
   * Every business in this database currently has NULL coordinates, because
   * nothing in the live onboarding flow ever wrote them. Rather than skip,
   * the test stamps a point on the borrowed business for the duration of the
   * run and puts it back afterwards - the dispatch maths is what is under
   * test here, not the data gap.
   *
   * Dapoli, Ratnagiri: the district Swachham actually serves.
   */
  const FIXTURE_LAT = 17.7594;
  const FIXTURE_LNG = 73.1889;

  let stampedBusinessId: string | null = null;
  if (order.lat === null && order.business_id) {
    stampedBusinessId = String(order.business_id);
    await query(`UPDATE businesses SET latitude = ?, longitude = ? WHERE id = ?`, [
      FIXTURE_LAT,
      FIXTURE_LNG,
      stampedBusinessId,
    ]);
    console.log(`(stamped a temporary pickup point on business ${stampedBusinessId})`);
  }

  const lat = order.lat === null ? FIXTURE_LAT : Number(order.lat);
  const lng = order.lng === null ? FIXTURE_LNG : Number(order.lng);

  console.log(`Order ${order.order_number} (id ${orderId}) at ${lat},${lng}, status ${prevStatus}\n`);

  const riderA = await ensureRider(RIDER_A_MOBILE, 'Smoke Rider A');
  const riderB = await ensureRider(RIDER_B_MOBILE, 'Smoke Rider B');
  let jobId: string | undefined;

  try {
    // ---- 1. Profiles are created on first touch ----
    console.log('1. Rider profiles');
    const profileA = await getOrCreateProfile(riderA);
    check('profile auto-created for a RIDER user', profileA.user_id === riderA);
    check('a new rider starts offline', profileA.is_online === false);

    // ---- 2. Going online needs a position ----
    console.log('\n2. Duty state');
    let refused = false;
    try {
      await setOnlineStatus(riderA, true);
    } catch {
      refused = true;
    }
    check('going online without coordinates is refused', refused);

    // Rider A is 400 m away, rider B is 2 km away — both inside the radius.
    const onlineA = await setOnlineStatus(riderA, true, {
      latitude: lat + 0.0036,
      longitude: lng,
      accuracy: 12,
    });
    await setOnlineStatus(riderB, true, {
      latitude: lat + 0.018,
      longitude: lng,
      accuracy: 12,
    });
    check('rider goes online with a fix', onlineA.is_online === true);

    // ---- 3. Job creation ----
    console.log('\n3. Job creation');
    const job = await createJobForOrder(orderId, 'PICKUP');
    check('pickup job created', Boolean(job));
    if (!job) throw new Error('no job');
    jobId = job.id;
    check('destination snapshotted onto the job', job.latitude !== null);
    check('handover code issued', Boolean(job.handover_code));

    const duplicate = await createJobForOrder(orderId, 'PICKUP');
    check('a second pickup for the same order reuses the first', duplicate?.id === job.id);

    // ---- 4. Dispatch ----
    console.log('\n4. Dispatch');
    const dispatched = await dispatchJob(job.id);
    check('offered to the nearby riders', dispatched.offered >= 2, `offered=${dispatched.offered}`);

    const offers = await query<any>(
      `SELECT rider_id, distance_m FROM rider_job_offers WHERE job_id = ? ORDER BY distance_m ASC`,
      [job.id]
    );
    check('nearest rider is ordered first', String(offers.rows[0]?.rider_id) === riderA);
    check(
      'distance is recorded and plausible',
      Number(offers.rows[0]?.distance_m) > 300 && Number(offers.rows[0]?.distance_m) < 500,
      `${offers.rows[0]?.distance_m}m`
    );

    // ---- 5. First accept wins ----
    console.log('\n5. Race for the job');
    const accepted = await acceptJob(job.id, riderA);
    check('first rider takes the job', accepted.rider_id === riderA);

    let loserRejected = false;
    let loserMessage = '';
    try {
      await acceptJob(job.id, riderB);
    } catch (error: any) {
      loserRejected = true;
      loserMessage = error?.message || '';
    }
    check('second rider is refused', loserRejected, loserMessage);
    check('refusal explains why', /already taken/i.test(loserMessage), loserMessage);

    const orderAfterAccept = await query<any>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    check(
      'order moves to PICKUP_ASSIGNED',
      orderAfterAccept.rows[0]?.status === 'PICKUP_ASSIGNED',
      orderAfterAccept.rows[0]?.status
    );

    // ---- 6. The job pipeline ----
    console.log('\n6. Working the job');
    let skipRejected = false;
    try {
      await updateJobStatus(riderA, job.id, 'ARRIVED');
    } catch {
      skipRejected = true;
    }
    check('cannot skip straight to arrived', skipRejected);

    await updateJobStatus(riderA, job.id, 'EN_ROUTE');
    const arrived = await updateJobStatus(riderA, job.id, 'ARRIVED');
    check('en route then arrived', arrived.status === 'ARRIVED');

    // ---- 7. Handover ----
    console.log('\n7. Handover');
    let wrongCodeRejected = false;
    try {
      await completeJob(riderA, job.id, '0000');
    } catch {
      wrongCodeRejected = true;
    }
    check('a wrong handover code is refused', wrongCodeRejected);

    const collected = await completeJob(riderA, job.id, String(job.handover_code));
    check('correct code collects the job', collected.status === 'COLLECTED');

    const finalOrder = await query<any>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    check(
      'order moves to PICKED_UP',
      finalOrder.rows[0]?.status === 'PICKED_UP',
      finalOrder.rows[0]?.status
    );

    // ---- 8. Carrying it to the facility ----
    console.log('');
    console.log('8. Collected, not yet delivered');
    const carrying = await getOrCreateProfile(riderA);
    check('a collected pickup is NOT yet counted as completed', carrying.completed_jobs === 0);
    check('and it still counts as active work', carrying.active_job_count === 1);

    // ---- 9. Drop at the facility ----
    console.log('');
    console.log('9. Facility drop-off');
    const dropped = await dropAtFacility(riderA);
    check('the drop closes the pickup', dropped.dropped === 1);
    check('nothing left with the rider', dropped.still_carrying === 0);

    const profileAfter = await getOrCreateProfile(riderA);
    check('rider completed count incremented', profileAfter.completed_jobs === 1);
    check('active job count returned to zero', profileAfter.active_job_count === 0);
  } finally {
    await cleanup([riderA, riderB], jobId, orderId, prevStatus);
    if (stampedBusinessId) {
      await query(`UPDATE businesses SET latitude = NULL, longitude = NULL WHERE id = ?`, [
        stampedBusinessId,
      ]);
    }
    console.log('\n(cleaned up test riders, job and order status)');
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  await pool.end();
  process.exit(1);
});
