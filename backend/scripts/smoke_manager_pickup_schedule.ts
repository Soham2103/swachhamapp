/**
 * Smoke test for: the pickup a Manager assigns at approval, as the CUSTOMER
 * and the BUSINESS then see it.
 *
 * The manager half is covered by smoke_manager_order_approval. This one asks
 * the question that feature is actually for:
 *
 *   BOTH SIDES READ ONE SOURCE      the customer's tracker and the business's
 *                                   order screen return the same date and
 *                                   time for the same order, because both
 *                                   read `orders.assigned_pickup_*`.
 *
 *   NOTHING IS SHOWN UNTIL ASSIGNED an order still waiting on a Manager
 *                                   returns null for both, so a screen has
 *                                   nothing to display rather than a
 *                                   placeholder or a booking slot.
 *
 *   A CHANGE REACHES BOTH           rescheduling updates what each side
 *                                   reads, with no second order created.
 *
 *   ORDERS DO NOT BLEED             two orders assigned different pickups
 *                                   keep their own, before and after a change.
 *
 * It creates its own bookings and deletes them again, so the database is left
 * as it was found.
 *
 *   npx ts-node scripts/smoke_manager_pickup_schedule.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import { getBusinessNow, addDays } from '../src/utils/istTime';
import { PENDING_STATUS } from '../src/services/managerOrderApproval.service';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5000';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html error page */ }
  return { status: res.status, json };
}

/** The times the server offers on a date, still bookable, in order. */
async function timesOn(token: string, date: string): Promise<any[]> {
  const res = await api(`/api/manager/order-requests/pickup-times?date=${date}`, token);
  return (res.json?.data || []).filter((time: any) => time.available);
}

/** HH:MM from either "16:00" or "16:00:00", so the two shapes compare. */
const hhmm = (value: unknown) => String(value ?? '').slice(0, 5);

async function main() {
  const manager = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'MANAGER' AND is_active = 1 LIMIT 1`
  )).rows[0];
  if (!manager) throw new Error('No active MANAGER to test with.');
  const managerToken = generateAccessToken({
    id: String(manager.id), email: manager.email || 'm@x.z', role: 'MANAGER',
  });

  const customer = (await query<any>(
    `SELECT id, mobile_number FROM users
      WHERE role = 'CUSTOMER' AND is_active = 1 ORDER BY id DESC LIMIT 1`
  )).rows[0];
  if (!customer) throw new Error('No active CUSTOMER to test with.');
  const customerToken = generateAccessToken({
    id: String(customer.id), email: 'c@x.z', role: 'CUSTOMER',
    mobile_number: customer.mobile_number,
  } as any);

  const bizUser = (await query<any>(`SELECT id FROM business_users LIMIT 1`)).rows[0];
  if (!bizUser) throw new Error('No business user to test with.');
  const bizToken = generateAccessToken({
    id: String(bizUser.id), email: 'b@x.z', role: 'BUSINESS',
  } as any);

  /*
   * Two bookings, and a PICKUPS ROW ON EACH.
   *
   * The row is seeded deliberately: it is what both order flows create at
   * booking time, and on the business side it is an admitted placeholder. Its
   * presence here is what makes "nothing is shown until a Manager assigns
   * one" a real check rather than a vacuous one — without it, null would
   * prove nothing.
   */
  const now = await getBusinessNow();
  const bookedDate = addDays(now.date, 3);

  async function seed(kind: 'CUSTOMER' | 'BUSINESS'): Promise<string> {
    const number = `SMOKE#P${kind[0]}${Date.now()}${Math.floor(Math.random() * 100)}`;
    const inserted = kind === 'CUSTOMER'
      ? await query(
        `INSERT INTO orders (order_number, user_id, status, subtotal, total,
                             payment_method, payment_status)
         VALUES (?, ?, ?, 100, 100, 'CASH_ON_DELIVERY', 'PENDING')`,
        [number, customer.id, PENDING_STATUS]
      )
      : await query(
        `INSERT INTO orders (order_number, business_user_id, laundry_type, status, subtotal, total)
         VALUES (?, ?, 'hotel', ?, 200, 200)`,
        [number, bizUser.id, PENDING_STATUS]
      );
    const id = String(inserted.insertId);
    await query(
      `INSERT INTO pickups (order_id, scheduled_date, time_slot_start, time_slot_end, status)
       VALUES (?, ?, '09:00:00', '11:00:00', 'SCHEDULED')`,
      [id, bookedDate]
    );
    return id;
  }

  const custOrderId = await seed('CUSTOMER');
  const bizOrderId = await seed('BUSINESS');
  console.log(`\nSeeded customer order ${custOrderId}, business order ${bizOrderId}`);

  const ordersBefore = Number((await query<any>(`SELECT COUNT(*) AS n FROM orders`)).rows[0].n);

  try {
    /* ============================================================
     * 1. BEFORE A MANAGER ASSIGNS ANYTHING
     * ============================================================ */
    console.log('\n1. NOTHING IS SHOWN UNTIL A PICKUP IS ASSIGNED');

    const trackBefore = await api(`/api/orders/${custOrderId}/tracking`, customerToken);
    check('the customer tracker loads', trackBefore.status === 200,
      `status ${trackBefore.status}`);
    check('and reports NO assigned pickup',
      trackBefore.json?.data?.assigned_pickup_date === null
        && trackBefore.json?.data?.assigned_pickup_time === null,
      `${trackBefore.json?.data?.assigned_pickup_date} / ${trackBefore.json?.data?.assigned_pickup_time}`);
    check('even though the order HAS a booked pickup slot',
      !!trackBefore.json?.data?.pickup?.scheduled_date,
      `booked ${String(trackBefore.json?.data?.pickup?.scheduled_date).slice(0, 10)}`);

    const bizBefore = await api(`/api/businesses/orders/${bizOrderId}`, bizToken);
    check('the business order detail reports no assigned pickup either',
      bizBefore.json?.data?.assigned_pickup_date === null
        && bizBefore.json?.data?.assigned_pickup_time === null,
      `${bizBefore.json?.data?.assigned_pickup_date} / ${bizBefore.json?.data?.assigned_pickup_time}`);

    /* ============================================================
     * 2. THE MANAGER ASSIGNS TWO DIFFERENT PICKUPS
     * ============================================================ */
    console.log('\n2. THE MANAGER ASSIGNS');

    const day = addDays(now.date, 1);
    const times = await timesOn(managerToken, day);
    check('the server offers pickup times for tomorrow', times.length >= 2,
      `${times.length} time(s)`);

    // Two DIFFERENT times, so a value appearing on the wrong order is visible
    // rather than hidden behind a coincidence.
    const custPickup = { pickupDate: day, pickupTime: times[0].id };
    const bizPickup = { pickupDate: day, pickupTime: times[1].id };

    const custAccept = await api(
      `/api/manager/order-requests/${custOrderId}/accept`, managerToken,
      { method: 'POST', body: custPickup }
    );
    const bizAccept = await api(
      `/api/manager/order-requests/${bizOrderId}/accept`, managerToken,
      { method: 'POST', body: bizPickup }
    );
    check('the customer booking accepts', custAccept.status === 200, `status ${custAccept.status}`);
    check('the business booking accepts', bizAccept.status === 200, `status ${bizAccept.status}`);

    /* ============================================================
     * 3. THE CUSTOMER SEES IT, WITHOUT ENTERING ANYTHING
     * ============================================================ */
    console.log('\n3. THE CUSTOMER SIDE');

    const track = await api(`/api/orders/${custOrderId}/tracking`, customerToken);
    check('the tracker now carries the assigned pickup date',
      track.json?.data?.assigned_pickup_date === custPickup.pickupDate,
      `${track.json?.data?.assigned_pickup_date} vs ${custPickup.pickupDate}`);
    check('and the assigned pickup time',
      hhmm(track.json?.data?.assigned_pickup_time) === hhmm(custPickup.pickupTime),
      `${track.json?.data?.assigned_pickup_time} vs ${custPickup.pickupTime}`);
    check('the DATE is a plain YYYY-MM-DD, not a timestamp a device could shift',
      /^\d{4}-\d{2}-\d{2}$/.test(String(track.json?.data?.assigned_pickup_date)),
      String(track.json?.data?.assigned_pickup_date));

    const detail = await api(`/api/orders/${custOrderId}`, customerToken);
    check('the customer order detail agrees with the tracker',
      String(detail.json?.data?.assigned_pickup_date) === custPickup.pickupDate
        && hhmm(detail.json?.data?.assigned_pickup_time) === hhmm(custPickup.pickupTime),
      `${detail.json?.data?.assigned_pickup_date} ${detail.json?.data?.assigned_pickup_time}`);

    /* ============================================================
     * 4. THE BUSINESS SEES ITS OWN, ON BOTH SCREENS
     * ============================================================ */
    console.log('\n4. THE BUSINESS SIDE');

    const bizDetail = await api(`/api/businesses/orders/${bizOrderId}`, bizToken);
    const bizTrack = await api(`/api/businesses/orders/${bizOrderId}/tracking`, bizToken);
    check('the business order detail carries the assigned pickup',
      bizDetail.json?.data?.assigned_pickup_date === bizPickup.pickupDate
        && hhmm(bizDetail.json?.data?.assigned_pickup_time) === hhmm(bizPickup.pickupTime),
      `${bizDetail.json?.data?.assigned_pickup_date} ${bizDetail.json?.data?.assigned_pickup_time}`);
    check('the business TRACKING screen reads the same values',
      bizTrack.json?.data?.assigned_pickup_date === bizDetail.json?.data?.assigned_pickup_date
        && bizTrack.json?.data?.assigned_pickup_time === bizDetail.json?.data?.assigned_pickup_time,
      `${bizTrack.json?.data?.assigned_pickup_date} ${bizTrack.json?.data?.assigned_pickup_time}`);

    const bizList = await api('/api/businesses/orders', bizToken);
    const listed = (bizList.json?.data || []).find((o: any) => String(o.id) === bizOrderId);
    check('and so does the business orders LIST',
      listed?.assigned_pickup_date === bizPickup.pickupDate,
      `${listed?.assigned_pickup_date}`);

    check('THE TWO ORDERS KEPT THEIR OWN TIMES',
      hhmm(track.json?.data?.assigned_pickup_time)
        !== hhmm(bizTrack.json?.data?.assigned_pickup_time),
      `customer ${track.json?.data?.assigned_pickup_time}, `
        + `business ${bizTrack.json?.data?.assigned_pickup_time}`);

    /* ============================================================
     * 5. A CHANGE REACHES BOTH SIDES
     * ============================================================ */
    console.log('\n5. CHANGING THE PICKUP');

    const newDay = addDays(now.date, 2);
    const newTimes = await timesOn(managerToken, newDay);
    const moved = { pickupDate: newDay, pickupTime: newTimes[newTimes.length - 1].id };

    const patch = await api(
      `/api/manager/order-requests/${custOrderId}/pickup`, managerToken,
      { method: 'PATCH', body: moved }
    );
    check('the manager can move it', patch.status === 200, `status ${patch.status}`);

    const trackAfter = await api(`/api/orders/${custOrderId}/tracking`, customerToken);
    check('THE CUSTOMER SEES THE NEW TIME',
      trackAfter.json?.data?.assigned_pickup_date === moved.pickupDate
        && hhmm(trackAfter.json?.data?.assigned_pickup_time) === hhmm(moved.pickupTime),
      `${trackAfter.json?.data?.assigned_pickup_date} ${trackAfter.json?.data?.assigned_pickup_time}`);
    check('and the status is untouched by the change',
      trackAfter.json?.data?.status === 'ORDER_PLACED', trackAfter.json?.data?.status);

    const bizAfter = await api(`/api/businesses/orders/${bizOrderId}`, bizToken);
    check('THE OTHER ORDER WAS NOT MOVED WITH IT',
      bizAfter.json?.data?.assigned_pickup_date === bizPickup.pickupDate
        && hhmm(bizAfter.json?.data?.assigned_pickup_time) === hhmm(bizPickup.pickupTime),
      `${bizAfter.json?.data?.assigned_pickup_date} ${bizAfter.json?.data?.assigned_pickup_time}`);

    check('NO NEW ORDER was created by any of this',
      Number((await query<any>(`SELECT COUNT(*) AS n FROM orders`)).rows[0].n) === ordersBefore,
      `${ordersBefore} before`);

    /* ============================================================
     * 6. WHAT A CHANGE IS REFUSED FOR
     * ============================================================ */
    console.log('\n6. THE LIMITS');

    const past = await api(
      `/api/manager/order-requests/${custOrderId}/pickup`, managerToken,
      { method: 'PATCH', body: { pickupDate: addDays(now.date, -1), pickupTime: moved.pickupTime } }
    );
    check('a pickup in the past is refused', past.status === 400,
      `status ${past.status} — ${past.json?.message}`);

    const badTime = await api(
      `/api/manager/order-requests/${custOrderId}/pickup`, managerToken,
      { method: 'PATCH', body: { pickupDate: newDay, pickupTime: '03:17' } }
    );
    check('a time outside the working day is refused', badTime.status === 400,
      `status ${badTime.status} — ${badTime.json?.message}`);

    const stillMoved = await query<any>(
      `SELECT DATE_FORMAT(assigned_pickup_date, '%Y-%m-%d') AS d FROM orders WHERE id = ?`,
      [custOrderId]
    );
    check('and neither refusal changed what was stored',
      stillMoved.rows[0].d === moved.pickupDate, stillMoved.rows[0].d);
  } finally {
    /* ============================================================
     * 7. CLEAN UP
     * ============================================================ */
    console.log('\n7. CLEAN UP');

    for (const id of [custOrderId, bizOrderId]) {
      await query(`DELETE FROM order_status_history WHERE order_id = ?`, [id]);
      await query(`DELETE FROM rider_job_offers WHERE job_id IN
                     (SELECT id FROM rider_jobs WHERE order_id = ?)`, [id]);
      await query(`DELETE FROM rider_jobs WHERE order_id = ?`, [id]);
      await query(`DELETE FROM notifications WHERE order_id = ?`, [id]);
      await query(`DELETE FROM pickups WHERE order_id = ?`, [id]);
      await query(`DELETE FROM orders WHERE id = ?`, [id]);
    }
    const left = await query<any>(
      `SELECT COUNT(*) AS n FROM orders WHERE id IN (?, ?)`, [custOrderId, bizOrderId]
    );
    check('the seeded bookings are removed', Number(left.rows[0].n) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
