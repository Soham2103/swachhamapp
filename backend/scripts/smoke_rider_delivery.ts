/**
 * Smoke test: a DELIVERY is matched on the FACILITY, not the customer.
 *
 *   npx ts-node --transpile-only scripts/smoke_rider_delivery.ts
 *
 * The distinction this proves is the whole point of the origin field. Two
 * riders are placed so that the answer differs depending on which point is
 * used:
 *
 *   Rider NEAR-FACILITY   close to the facility, far from the customer
 *   Rider NEAR-CUSTOMER   close to the customer, far from the facility
 *
 * A pickup must go to NEAR-CUSTOMER. A delivery must go to NEAR-FACILITY,
 * because the rider has to load before they can deliver. If both went the
 * same way the origin is being ignored.
 *
 * Creates two throwaway riders and one job, and puts everything back.
 */

import { pool, query } from '../src/config/database';
import { config } from '../src/config/env';
import { createJobForOrder, dispatchJob } from '../src/services/dispatch.service';
import { setOnlineStatus } from '../src/services/rider.service';

const NEAR_FACILITY_MOBILE = '9000000031';
const NEAR_CUSTOMER_MOBILE = '9000000032';

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

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dy = (aLat - bLat) * 111320;
  const dx = (aLng - bLng) * 111320 * Math.cos((bLat * Math.PI) / 180);
  return Math.round(Math.sqrt(dx * dx + dy * dy));
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
  console.log('=== DELIVERY MATCHES ON THE FACILITY ===');
  console.log('');

  const fLat = config.FACILITY_LATITUDE;
  const fLng = config.FACILITY_LONGITUDE;
  console.log(`Facility: ${fLat}, ${fLng}`);

  const orderRow = await query<any>(
    `SELECT o.id, o.order_number, o.status, b.latitude AS lat, b.longitude AS lng,
            COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
       JOIN businesses b      ON b.id = bu.business_id
      WHERE b.latitude IS NOT NULL
      ORDER BY o.id DESC LIMIT 1`
  );
  if (orderRow.rows.length === 0) {
    console.log('  SKIP  No order from a located business.');
    await pool.end();
    return;
  }

  const order = orderRow.rows[0];
  const orderId = String(order.id);
  const cLat = Number(order.lat);
  const cLng = Number(order.lng);
  console.log(`Customer: ${order.business} at ${cLat}, ${cLng}`);
  console.log(`Facility is ${metres(fLat, fLng, cLat, cLng)} m from the customer`);
  console.log('');

  /*
   * Each rider sits ~300 m from one point. Because the facility and the
   * customer are a couple of kilometres apart, each rider is unambiguously
   * near one and far from the other — so the two match points cannot give
   * the same answer by accident.
   */
  const nearFacility = { lat: fLat + 0.0027, lng: fLng };
  const nearCustomer = { lat: cLat + 0.0027, lng: cLng };

  const riderF = await ensureRider(NEAR_FACILITY_MOBILE, 'Near Facility');
  const riderC = await ensureRider(NEAR_CUSTOMER_MOBILE, 'Near Customer');
  const jobIds: string[] = [];
  const prevStatus = order.status;

  try {
    await setOnlineStatus(riderF, true, {
      latitude: nearFacility.lat,
      longitude: nearFacility.lng,
      accuracy: 10,
    });
    await setOnlineStatus(riderC, true, {
      latitude: nearCustomer.lat,
      longitude: nearCustomer.lng,
      accuracy: 10,
    });

    console.log('Riders:');
    console.log(
      `  Near Facility: ${metres(nearFacility.lat, nearFacility.lng, fLat, fLng)} m from facility, ` +
        `${metres(nearFacility.lat, nearFacility.lng, cLat, cLng)} m from customer`
    );
    console.log(
      `  Near Customer: ${metres(nearCustomer.lat, nearCustomer.lng, fLat, fLng)} m from facility, ` +
        `${metres(nearCustomer.lat, nearCustomer.lng, cLat, cLng)} m from customer`
    );

    // ---- PICKUP: matched on the customer ----
    console.log('');
    console.log('1. PICKUP is matched on the customer');
    await query(
      `DELETE FROM rider_job_offers WHERE job_id IN
         (SELECT id FROM rider_jobs WHERE order_id = ?)`,
      [orderId]
    );
    await query(`DELETE FROM rider_jobs WHERE order_id = ?`, [orderId]);

    const pickup = await createJobForOrder(orderId, 'PICKUP');
    if (!pickup) throw new Error('no pickup job');
    jobIds.push(pickup.id);
    check('a pickup has no origin', pickup.origin_latitude === null);

    await dispatchJob(pickup.id);
    const pickupOffers = await query<any>(
      `SELECT rider_id, distance_m FROM rider_job_offers
        WHERE job_id = ? ORDER BY distance_m ASC`,
      [pickup.id]
    );
    check(
      'nearest to the CUSTOMER is offered first',
      String(pickupOffers.rows[0]?.rider_id) === riderC,
      `winner rider ${pickupOffers.rows[0]?.rider_id}, riderC=${riderC}`
    );

    // ---- DELIVERY: matched on the facility ----
    console.log('');
    console.log('2. DELIVERY is matched on the facility');
    const delivery = await createJobForOrder(orderId, 'DELIVERY');
    if (!delivery) throw new Error('no delivery job');
    jobIds.push(delivery.id);

    check('a delivery carries the facility as its origin', delivery.origin_latitude !== null);
    check(
      'and that origin IS the configured facility',
      Math.abs(Number(delivery.origin_latitude) - fLat) < 0.0001,
      `${delivery.origin_latitude} vs ${fLat}`
    );
    check(
      'while its destination stays the customer',
      Math.abs(Number(delivery.latitude) - cLat) < 0.0001,
      `${delivery.latitude} vs ${cLat}`
    );

    await dispatchJob(delivery.id);
    const deliveryOffers = await query<any>(
      `SELECT rider_id, distance_m FROM rider_job_offers
        WHERE job_id = ? ORDER BY distance_m ASC`,
      [delivery.id]
    );
    check(
      'nearest to the FACILITY is offered first',
      String(deliveryOffers.rows[0]?.rider_id) === riderF,
      `winner rider ${deliveryOffers.rows[0]?.rider_id}, riderF=${riderF}`
    );
    check(
      'the recorded distance is to the facility, not the customer',
      Number(deliveryOffers.rows[0]?.distance_m) < 500,
      `${deliveryOffers.rows[0]?.distance_m} m`
    );

    // The two must genuinely disagree, or nothing has been proved.
    console.log('');
    console.log('3. The two match points disagree');
    check(
      'pickup and delivery went to DIFFERENT riders',
      String(pickupOffers.rows[0]?.rider_id) !== String(deliveryOffers.rows[0]?.rider_id)
    );
  } finally {
    for (const id of jobIds) {
      await query(`DELETE FROM rider_job_offers WHERE job_id = ?`, [id]);
      await query(`DELETE FROM rider_jobs WHERE id = ?`, [id]);
    }
    await query(`UPDATE orders SET status = ? WHERE id = ?`, [prevStatus, orderId]);
    for (const id of [riderF, riderC]) {
      await query(`DELETE FROM rider_profiles WHERE user_id = ?`, [id]);
      await query(`DELETE FROM notifications WHERE user_id = ?`, [id]);
      await query(`DELETE FROM users WHERE id = ?`, [id]);
    }
    console.log('');
    console.log('(cleaned up riders, jobs and order status)');
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
