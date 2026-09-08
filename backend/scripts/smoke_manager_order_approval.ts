/**
 * Smoke test for: Customer/Business booking -> Manager -> Sorter + Rider.
 *
 * The things that matter, and that are easy to get silently wrong:
 *
 *   IT DOES NOT REACH THE FLOOR EARLY   a new booking is invisible to the
 *                                       Sorter queue until a Manager accepts.
 *
 *   THE TWO TABS DO NOT LEAK            a customer booking never appears under
 *                                       Business Requests, or the reverse.
 *
 *   ONE ORDER THROUGHOUT                the id the customer created, the id the
 *                                       Manager accepted, and the id the Sorter
 *                                       then sees are the same row. No second
 *                                       order is created anywhere.
 *
 *   THE STATUS IS THE BACKEND'S         accepting writes ORDER_PLACED to the
 *                                       database, and every reader picks it up.
 *
 * It creates its own bookings and deletes them again, so the database is left
 * as it was found.
 *
 *   npx ts-node scripts/smoke_manager_order_approval.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import { PENDING_STATUS, APPROVED_STATUS } from '../src/services/managerOrderApproval.service';
import { getBusinessNow, addDays } from '../src/utils/istTime';

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

/**
 * A pickup a Manager could actually assign: tomorrow, at the first time the
 * server offers for that day.
 *
 * TOMORROW rather than today, so the run cannot fail because it happened
 * after the last slot; and the TIME comes from the server's own list rather
 * than a constant here, so this cannot drift from what the working day is.
 */
async function pickupFor(token: string): Promise<{ pickupDate: string; pickupTime: string }> {
  const now = await getBusinessNow();
  const pickupDate = addDays(now.date, 1);

  const res = await api(
    `/api/manager/order-requests/pickup-times?date=${pickupDate}`, token
  );
  const first = (res.json?.data || []).find((time: any) => time.available);
  if (!first) throw new Error('the server offered no pickup times for tomorrow');

  return { pickupDate, pickupTime: first.id };
}

/** The Sorter's own queue predicate, as `sorter.service` defines it. */
const SORTER_QUEUE = [
  'ORDER_PLACED', 'RECEIVED_AT_FACILITY', 'READY_FOR_DELIVERY',
  'PARTIALLY_COMPLETED', 'OUT_FOR_DELIVERY',
];

async function inSorterQueue(orderId: string): Promise<boolean> {
  const r = await query<any>(
    `SELECT COUNT(*) AS n FROM orders
      WHERE id = ? AND status IN (${SORTER_QUEUE.map(() => '?').join(',')})`,
    [orderId, ...SORTER_QUEUE]
  );
  return Number(r.rows[0].n) === 1;
}

/** Creates a booking row directly, standing in for the two order services. */
async function seedBooking(kind: 'CUSTOMER' | 'BUSINESS'): Promise<string> {
  const number = `SMOKE#${kind[0]}${Date.now()}${Math.floor(Math.random() * 100)}`;
  if (kind === 'CUSTOMER') {
    const user = (await query<any>(
      `SELECT id FROM users WHERE role = 'CUSTOMER' AND is_active = 1 LIMIT 1`
    )).rows[0];
    const r = await query(
      `INSERT INTO orders (order_number, user_id, status, subtotal, total, payment_method, payment_status)
       VALUES (?, ?, ?, 100, 100, 'CASH_ON_DELIVERY', 'PENDING')`,
      [number, user.id, PENDING_STATUS]
    );
    return String(r.insertId);
  }
  const bu = (await query<any>(`SELECT id FROM business_users LIMIT 1`)).rows[0];
  const r = await query(
    `INSERT INTO orders (order_number, business_user_id, laundry_type, status, subtotal, total)
     VALUES (?, ?, 'hotel', ?, 200, 200)`,
    [number, bu.id, PENDING_STATUS]
  );
  return String(r.insertId);
}

async function main() {
  const manager = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'MANAGER' AND is_active = 1 LIMIT 1`
  )).rows[0];
  if (!manager) throw new Error('No active MANAGER to test with.');
  const managerToken = generateAccessToken({
    id: String(manager.id), email: manager.email || 'm@x.z', role: 'MANAGER',
  });

  const customerOrderId = await seedBooking('CUSTOMER');
  const businessOrderId = await seedBooking('BUSINESS');
  console.log(`\nSeeded customer order ${customerOrderId}, business order ${businessOrderId}`);

  const ordersBefore = Number((await query<any>(`SELECT COUNT(*) AS n FROM orders`)).rows[0].n);

  try {
    /* ============================================================
     * 1. A NEW BOOKING DOES NOT REACH SORTER OR RIDER
     * ============================================================ */
    console.log('\n1. BEFORE APPROVAL');

    check('a new customer booking is NOT in the Sorter queue',
      !(await inSorterQueue(customerOrderId)));
    check('a new business booking is NOT in the Sorter queue',
      !(await inSorterQueue(businessOrderId)));

    const riderJobs = await query<any>(
      `SELECT COUNT(*) AS n FROM rider_jobs WHERE order_id IN (?, ?)`,
      [customerOrderId, businessOrderId]
    );
    check('no rider job exists for either', Number(riderJobs.rows[0].n) === 0,
      `${riderJobs.rows[0].n} job(s)`);

    /* ============================================================
     * 2. THE TWO TABS, AND THEY DO NOT LEAK
     * ============================================================ */
    console.log('\n2. THE MANAGER\'S TWO TABS');

    const customerTab = await api('/api/manager/order-requests/customer', managerToken);
    const businessTab = await api('/api/manager/order-requests/business', managerToken);
    check('the customer tab loads', customerTab.status === 200, `status ${customerTab.status}`);
    check('the business tab loads', businessTab.status === 200, `status ${businessTab.status}`);

    const inCustomer = (ids: any) => (ids.json?.data || []).map((r: any) => String(r.id));
    check('the customer booking is in Customer Requests',
      inCustomer(customerTab).includes(customerOrderId));
    check('and NOT in Business Requests',
      !inCustomer(businessTab).includes(customerOrderId));
    check('the business booking is in Business Requests',
      inCustomer(businessTab).includes(businessOrderId));
    check('and NOT in Customer Requests',
      !inCustomer(customerTab).includes(businessOrderId));

    check('every row in the customer tab is marked CUSTOMER',
      (customerTab.json?.data || []).every((r: any) => r.source === 'CUSTOMER'));
    check('every row in the business tab is marked BUSINESS',
      (businessTab.json?.data || []).every((r: any) => r.source === 'BUSINESS'));

    const row = (customerTab.json?.data || []).find((r: any) => String(r.id) === customerOrderId);
    check('the row carries the existing order information',
      !!row?.order_number && !!row?.customer_name && Number(row?.total) === 100,
      `${row?.order_number} · ${row?.customer_name} · ₹${row?.total}`);

    const counts = await api('/api/manager/order-requests/counts', managerToken);
    check('the counts endpoint reports both tabs',
      counts.json?.data?.CUSTOMER >= 1 && counts.json?.data?.BUSINESS >= 1,
      JSON.stringify(counts.json?.data));

    /* ============================================================
     * 3. ACCEPTING
     * ============================================================ */
    console.log('\n3. THE MANAGER ACCEPTS');

    /*
     * THE PICKUP IS PART OF THE ACCEPTANCE, so an accept without one must be
     * refused rather than quietly placing an order nobody has agreed to
     * collect. Checked BEFORE the real accept, on the same order, so a
     * regression here cannot hide behind a later success.
     */
    const noPickup = await api(
      `/api/manager/order-requests/${customerOrderId}/accept`, managerToken, { method: 'POST' }
    );
    check('an accept with NO pickup is refused with 400', noPickup.status === 400,
      `status ${noPickup.status}`);
    check('and the order is still pending',
      (await query<any>(`SELECT status FROM orders WHERE id = ?`, [customerOrderId]))
        .rows[0].status === PENDING_STATUS);

    const pastPickup = await api(
      `/api/manager/order-requests/${customerOrderId}/accept`, managerToken,
      { method: 'POST', body: { pickupDate: '2020-01-01', pickupTime: '09:00' } }
    );
    check('a pickup in the PAST is refused', pastPickup.status === 400,
      `status ${pastPickup.status} — ${pastPickup.json?.message}`);

    const pickup = await pickupFor(managerToken);
    const accepted = await api(
      `/api/manager/order-requests/${customerOrderId}/accept`, managerToken,
      { method: 'POST', body: pickup }
    );
    check('the accept succeeds', accepted.status === 200, `status ${accepted.status}`);
    check('it returns THE SAME order id', String(accepted.json?.data?.id) === customerOrderId,
      `${accepted.json?.data?.id} vs ${customerOrderId}`);

    const stored = await query<any>(
      `SELECT status, manager_approved_at, manager_approved_by,
              DATE_FORMAT(assigned_pickup_date, '%Y-%m-%d') AS assigned_pickup_date,
              assigned_pickup_time, pickup_assigned_by
         FROM orders WHERE id = ?`,
      [customerOrderId]
    );
    check('THE DATABASE holds ORDER_PLACED — not just the response',
      stored.rows[0].status === APPROVED_STATUS, stored.rows[0].status);
    check('and it records who accepted it, and when',
      String(stored.rows[0].manager_approved_by) === String(manager.id)
        && !!stored.rows[0].manager_approved_at);
    check('THE ASSIGNED PICKUP is stored against the order',
      stored.rows[0].assigned_pickup_date === pickup.pickupDate
        && String(stored.rows[0].assigned_pickup_time).startsWith(pickup.pickupTime),
      `${stored.rows[0].assigned_pickup_date} ${stored.rows[0].assigned_pickup_time}`);
    check('and records which manager assigned it',
      String(stored.rows[0].pickup_assigned_by) === String(manager.id));

    // The operational row is kept in step, so the rider and the delivery rule
    // work to the Manager's decision rather than to the booking placeholder.
    const pickupRow = await query<any>(
      `SELECT DATE_FORMAT(scheduled_date, '%Y-%m-%d') AS d, time_slot_start
         FROM pickups WHERE order_id = ?`, [customerOrderId]
    );
    check('the pickups row was moved to match',
      pickupRow.rows[0]?.d === pickup.pickupDate
        && String(pickupRow.rows[0]?.time_slot_start).startsWith(pickup.pickupTime),
      `${pickupRow.rows[0]?.d} ${pickupRow.rows[0]?.time_slot_start}`);

    const history = await query<any>(
      `SELECT status, notes FROM order_status_history
        WHERE order_id = ? ORDER BY id DESC LIMIT 1`, [customerOrderId]
    );
    check('the existing status history records the transition',
      history.rows[0]?.status === APPROVED_STATUS,
      `${history.rows[0]?.status} — "${history.rows[0]?.notes}"`);

    /* ============================================================
     * 4. NOW IT REACHES THE FLOOR — AND IT IS THE SAME ORDER
     * ============================================================ */
    console.log('\n4. AFTER APPROVAL');

    check('the accepted order IS now in the Sorter queue',
      await inSorterQueue(customerOrderId));
    check('the un-accepted business booking still is NOT',
      !(await inSorterQueue(businessOrderId)));

    check('NO NEW ORDER was created by any of this',
      Number((await query<any>(`SELECT COUNT(*) AS n FROM orders`)).rows[0].n) === ordersBefore,
      `${ordersBefore} before`);

    const gone = await api('/api/manager/order-requests/customer', managerToken);
    check('it has left the Manager queue',
      !inCustomer(gone).includes(customerOrderId));

    /* ============================================================
     * 5. ACCEPTING TWICE
     * ============================================================ */
    console.log('\n5. ACCEPTING TWICE');

    const again = await api(
      `/api/manager/order-requests/${customerOrderId}/accept`, managerToken,
      { method: 'POST', body: await pickupFor(managerToken) }
    );
    check('a second accept is refused with 409', again.status === 409, `status ${again.status}`);
    check('and says why', /already been accepted/i.test(again.json?.message || ''),
      again.json?.message);
    const historyCount = await query<any>(
      `SELECT COUNT(*) AS n FROM order_status_history
        WHERE order_id = ? AND status = ?`, [customerOrderId, APPROVED_STATUS]
    );
    check('no second history row was written', Number(historyCount.rows[0].n) === 1,
      `${historyCount.rows[0].n} row(s)`);

    /* ============================================================
     * 6. THE BUSINESS SIDE BEHAVES THE SAME
     * ============================================================ */
    console.log('\n6. THE BUSINESS FLOW');

    /*
     * A DIFFERENT PICKUP FROM THE CUSTOMER ORDER'S, deliberately: the point
     * of the checks below is that one order's collection never reaches
     * another's, and two identical times could not tell the two apart.
     */
    const bizPickup = await pickupFor(managerToken);
    const bizTimes = await api(
      `/api/manager/order-requests/pickup-times?date=${bizPickup.pickupDate}`, managerToken
    );
    const laterTime = (bizTimes.json?.data || [])
      .filter((t: any) => t.available)
      .find((t: any) => t.id !== pickup.pickupTime);
    if (laterTime) bizPickup.pickupTime = laterTime.id;

    const bizAccepted = await api(
      `/api/manager/order-requests/${businessOrderId}/accept`, managerToken,
      { method: 'POST', body: bizPickup }
    );
    check('a business booking accepts too', bizAccepted.status === 200,
      `status ${bizAccepted.status}`);
    check('it is reported as a BUSINESS order',
      bizAccepted.json?.data?.source === 'BUSINESS', bizAccepted.json?.data?.source);
    check('and reaches the Sorter queue', await inSorterQueue(businessOrderId));

    /* ============================================================
     * 6b. ONE ORDER'S PICKUP NEVER REACHES ANOTHER
     * ============================================================ */
    console.log('\n6b. PICKUPS ARE PER-ORDER');

    const both = await query<any>(
      `SELECT id, DATE_FORMAT(assigned_pickup_date, '%Y-%m-%d') AS d, assigned_pickup_time
         FROM orders WHERE id IN (?, ?)`,
      [customerOrderId, businessOrderId]
    );
    const custRow = both.rows.find((r: any) => String(r.id) === customerOrderId);
    const bizRow = both.rows.find((r: any) => String(r.id) === businessOrderId);
    check('the business order kept ITS OWN pickup',
      bizRow?.d === bizPickup.pickupDate
        && String(bizRow?.assigned_pickup_time).startsWith(bizPickup.pickupTime),
      `${bizRow?.d} ${bizRow?.assigned_pickup_time}`);
    check('and the customer order was not touched by it',
      custRow?.d === pickup.pickupDate
        && String(custRow?.assigned_pickup_time).startsWith(pickup.pickupTime),
      `${custRow?.d} ${custRow?.assigned_pickup_time}`);

    /* ============================================================
     * 6c. CHANGING A PICKUP AFTERWARDS
     * ============================================================ */
    console.log('\n6c. RESCHEDULING');

    const later = await pickupFor(managerToken);
    const moved = { pickupDate: addDays(later.pickupDate, 1), pickupTime: later.pickupTime };
    const rescheduled = await api(
      `/api/manager/order-requests/${customerOrderId}/pickup`, managerToken,
      { method: 'PATCH', body: moved }
    );
    check('a manager can move an accepted order\'s pickup', rescheduled.status === 200,
      `status ${rescheduled.status}`);

    const afterMove = await query<any>(
      `SELECT status, DATE_FORMAT(assigned_pickup_date, '%Y-%m-%d') AS d, assigned_pickup_time
         FROM orders WHERE id = ?`, [customerOrderId]
    );
    check('the new pickup is stored', afterMove.rows[0].d === moved.pickupDate,
      `${afterMove.rows[0].d} vs ${moved.pickupDate}`);
    check('THE STATUS IS UNCHANGED by rescheduling',
      afterMove.rows[0].status === APPROVED_STATUS, afterMove.rows[0].status);

    const bizUnmoved = await query<any>(
      `SELECT DATE_FORMAT(assigned_pickup_date, '%Y-%m-%d') AS d FROM orders WHERE id = ?`,
      [businessOrderId]
    );
    check('and the OTHER order was not moved with it',
      bizUnmoved.rows[0].d === bizPickup.pickupDate,
      `${bizUnmoved.rows[0].d} vs ${bizPickup.pickupDate}`);

    const scheduledTab = await api('/api/manager/order-requests/scheduled', managerToken);
    check('both accepted orders appear on the Scheduled tab',
      (scheduledTab.json?.data || []).some((r: any) => String(r.id) === customerOrderId)
        && (scheduledTab.json?.data || []).some((r: any) => String(r.id) === businessOrderId));

    /* ============================================================
     * 7. ONLY A MANAGER MAY DO THIS
     * ============================================================ */
    console.log('\n7. ROLE GUARD');

    const customer = (await query<any>(
      `SELECT id FROM users WHERE role = 'CUSTOMER' LIMIT 1`
    )).rows[0];
    const customerToken = generateAccessToken({
      id: String(customer.id), email: 'c@x.z', role: 'CUSTOMER',
    });
    const forbidden = await api('/api/manager/order-requests/customer', customerToken);
    check('a customer cannot read the manager queue', forbidden.status === 403,
      `status ${forbidden.status}`);
  } finally {
    /* ============================================================
     * RESTORE
     * ============================================================ */
    console.log('\n8. CLEAN UP');
    for (const id of [customerOrderId, businessOrderId]) {
      await query(`DELETE FROM order_status_history WHERE order_id = ?`, [id]);
      await query(`DELETE FROM rider_jobs WHERE order_id = ?`, [id]);
      await query(`DELETE FROM notifications WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM orders WHERE id = ?`, [id]);
    }
    const left = await query<any>(
      `SELECT COUNT(*) AS n FROM orders WHERE id IN (?, ?)`,
      [customerOrderId, businessOrderId]
    );
    check('the seeded bookings are removed', Number(left.rows[0].n) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
