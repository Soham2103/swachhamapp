/**
 * Smoke test for the HOLD answer.
 *
 *   npx ts-node --transpile-only scripts/smoke_rider_hold.ts
 *
 * The scenario the business described, end to end:
 *
 *   a rider collects an order and is carrying it
 *   -> a second order is offered while they still have the first
 *   -> the rider HOLDS it rather than passing it on
 *   -> the held job is reserved: nobody else is offered it
 *   -> the rider drops at the facility, freeing the bike
 *   -> the rider starts the held job and works it normally
 *
 * Creates two throwaway riders and two jobs, and puts everything back —
 * including the orders' statuses and the fixture coordinates.
 */

import { pool, query } from '../src/config/database';
import { createJobForOrder, dispatchJob, acceptJob, holdJob } from '../src/services/dispatch.service';
import {
  setOnlineStatus,
  updateJobStatus,
  completeJob,
  dropAtFacility,
  listOffers,
  listHeldJobs,
  startHeldJob,
  getOrCreateProfile,
} from '../src/services/rider.service';

const RIDER_A_MOBILE = '9000000021';
const RIDER_B_MOBILE = '9000000022';
const FIXTURE_LAT = 17.7594;
const FIXTURE_LNG = 73.1889;

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

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

async function main() {
  console.log('');
  console.log('=== RIDER HOLD SMOKE TEST ===');
  console.log('');

  /*
   * Two orders from the same located business, so both pickups land in the
   * same place and distance never decides which rider is asked.
   */
  /*
   * Both orders must belong to the SAME business.
   *
   * Two pickups at one address is what makes distance irrelevant to which
   * rider is asked, so the test measures capacity and nothing else. Taking
   * the two newest orders regardless of business does not do that: they came
   * from different establishments, only one of which had coordinates, so the
   * second job had no pickup point and was never dispatched at all.
   */
  const busiest = await query<any>(
    `SELECT bu.business_id, COUNT(*) AS n
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE o.total_weight_kg > 0
      GROUP BY bu.business_id
     HAVING n >= 2
      ORDER BY n DESC LIMIT 1`
  );

  if (busiest.rows.length === 0) {
    console.log('  SKIP  Need one business with two weighed orders.');
    await pool.end();
    return;
  }

  const orders = await query<any>(
    `SELECT o.id, o.order_number, o.status, o.total_weight_kg, bu.business_id
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ? AND o.total_weight_kg > 0
      ORDER BY o.total_weight_kg ASC LIMIT 2`,
    [String(busiest.rows[0].business_id)]
  );

  if (orders.rows.length < 2) {
    console.log('  SKIP  Need two orders with weights.');
    await pool.end();
    return;
  }

  const [first, second] = orders.rows;
  const businessId = String(first.business_id);

  const priorCoords = await query<any>(
    `SELECT latitude, longitude FROM businesses WHERE id = ?`,
    [businessId]
  );
  const hadCoords = priorCoords.rows[0]?.latitude !== null;
  if (!hadCoords) {
    await query(`UPDATE businesses SET latitude = ?, longitude = ? WHERE id = ?`, [
      FIXTURE_LAT,
      FIXTURE_LNG,
      businessId,
    ]);
  }
  const lat = hadCoords ? Number(priorCoords.rows[0].latitude) : FIXTURE_LAT;
  const lng = hadCoords ? Number(priorCoords.rows[0].longitude) : FIXTURE_LNG;

  console.log(`Order A ${first.order_number}: ${first.total_weight_kg} kg`);
  console.log(`Order B ${second.order_number}: ${second.total_weight_kg} kg`);
  console.log('');

  const riderA = await ensureRider(RIDER_A_MOBILE, 'Hold Rider A');
  const riderB = await ensureRider(RIDER_B_MOBILE, 'Hold Rider B');
  const jobIds: string[] = [];

  try {
    // Rider A is nearest and will do the carrying; rider B is a bystander
    // whose only job is to prove a held job is NOT offered to anyone else.
    await setOnlineStatus(riderA, true, { latitude: lat + 0.001, longitude: lng, accuracy: 10 });
    await setOnlineStatus(riderB, true, { latitude: lat + 0.004, longitude: lng, accuracy: 10 });

    console.log('1. First order collected');
    const jobA = await createJobForOrder(String(first.id), 'PICKUP');
    if (!jobA) throw new Error('no job A');
    jobIds.push(jobA.id);
    check('the job carries the order weight for display', Number(jobA.weight_kg) >= 0);

    await dispatchJob(jobA.id);
    await acceptJob(jobA.id, riderA);
    await updateJobStatus(riderA, jobA.id, 'EN_ROUTE');
    await updateJobStatus(riderA, jobA.id, 'ARRIVED');
    await completeJob(riderA, jobA.id, String(jobA.handover_code));

    const loaded = await getOrCreateProfile(riderA);
    check('the collected pickup is still open work', loaded.active_job_count === 1);
    check('and is not yet counted as completed', loaded.completed_jobs === 0);

    console.log('');
    console.log('2. A second order is offered while loaded');
    const jobB = await createJobForOrder(String(second.id), 'PICKUP');
    if (!jobB) throw new Error('no job B');
    jobIds.push(jobB.id);
    const dispatched = await dispatchJob(jobB.id);
    check('the second job reaches a rider at all', dispatched.offered > 0,
      `offered to ${dispatched.offered}`);

    const offers = await listOffers(riderA);
    const offerB = offers.find((o) => o.job_id === jobB.id);
    check('a rider already carrying one is still offered it', Boolean(offerB));
    check('the weight is shown so the rider can judge', offerB?.weight_kg !== undefined,
      `${offerB?.weight_kg} kg`);

    console.log('');
    console.log('3. Rider holds it instead of passing');
    const held = await holdJob(jobB.id, riderA);
    check('job is HELD, not assigned', held.status === 'HELD', held.status);

    const heldList = await listHeldJobs(riderA);
    check('it appears in the held list', heldList.length === 1);
    check('the reclaim countdown is shown', (heldList[0]?.reclaim_in_minutes ?? 0) > 0,
      `${heldList[0]?.reclaim_in_minutes} min`);

    // The whole point of holding rather than declining.
    const bystander = await listOffers(riderB);
    check('a held job is NOT offered to other riders',
      !bystander.some((o) => o.job_id === jobB.id));

    let takenByOther = false;
    try {
      await acceptJob(jobB.id, riderB);
      takenByOther = true;
    } catch {
      // expected
    }
    check('another rider cannot take a held job', !takenByOther);

    console.log('');
    console.log('4. Dropped off, held job started');
    const dropped = await dropAtFacility(riderA);
    check('the first pickup is closed at the facility', dropped.dropped === 1);
    check('nothing left with the rider', dropped.still_carrying === 0);

    const started = await startHeldJob(riderA, jobB.id);
    check('held job becomes assigned', started.status === 'ASSIGNED', started.status);
    check('and it is the same rider', String(started.job_id) === String(jobB.id));

    const afterStart = await listHeldJobs(riderA);
    check('held list is empty again', afterStart.length === 0);
  } finally {
    for (const id of jobIds) {
      await query(`DELETE FROM rider_job_offers WHERE job_id = ?`, [id]);
      await query(`DELETE FROM rider_jobs WHERE id = ?`, [id]);
    }
    for (const o of [first, second]) {
      await query(`UPDATE orders SET status = ? WHERE id = ?`, [o.status, o.id]);
      await query(
        `DELETE FROM order_status_history WHERE order_id = ? AND changed_by IN (?, ?)`,
        [o.id, riderA, riderB]
      );
    }
    for (const id of [riderA, riderB]) {
      await query(`DELETE FROM rider_profiles WHERE user_id = ?`, [id]);
      await query(`DELETE FROM notifications WHERE user_id = ?`, [id]);
      await query(`DELETE FROM users WHERE id = ?`, [id]);
    }
    if (!hadCoords) {
      await query(`UPDATE businesses SET latitude = NULL, longitude = NULL WHERE id = ?`, [
        businessId,
      ]);
    }
    console.log('');
    console.log('(cleaned up riders, jobs, order statuses and fixtures)');
  }

  console.log('');
  console.log(`=== ${pass} passed, ${fail} failed ===`);
  console.log('');
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error('SMOKE TEST CRASHED:', error);
  await pool.end();
  process.exit(1);
});
