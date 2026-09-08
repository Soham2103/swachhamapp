/**
 * END-TO-END: Customer/Business booking -> Manager -> Order Placed -> Sorter + Rider.
 *
 * WHY THIS EXISTS ALONGSIDE `smoke_manager_order_approval`. That test SEEDS
 * order rows straight into the table, so it proves the approval step but says
 * nothing about how a real booking gets there or what the downstream apps
 * actually return. This one drives the REAL APIs the apps call:
 *
 *   POST /api/orders                             the customer's booking
 *   GET  /api/manager/order-requests/customer    the Manager's tab
 *   POST /api/manager/order-requests/:id/accept  the Accept button
 *   GET  /api/sorter/orders                      what the Sorter app lists
 *   GET  /api/rider/offers                       what the Rider app is offered
 *
 * and asserts ONE order id survives all of them.
 *
 * It cleans up every row it creates.
 *
 *   npx ts-node scripts/smoke_order_flow_e2e.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
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

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {}
) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html error page */ }
  return { status: res.status, json, text };
}

/**
 * A pickup a Manager could assign: tomorrow, at the first time the server
 * offers for that day.
 *
 * Accepting requires one — a Manager names the collection as part of saying
 * yes — so every accept in this run goes through here. Tomorrow rather than
 * today so a late run cannot fall past the last time of the working day, and
 * the time comes from the server's list rather than a constant so this cannot
 * drift from what the working day actually is.
 */
async function pickupFor(token: string): Promise<{ pickupDate: string; pickupTime: string }> {
  const now = await getBusinessNow();
  const pickupDate = addDays(now.date, 1);
  const res = await api(`/api/manager/order-requests/pickup-times?date=${pickupDate}`, token);
  const first = (res.json?.data || []).find((time: any) => time.available);
  if (!first) throw new Error('the server offered no pickup times for tomorrow');
  return { pickupDate, pickupTime: first.id };
}

/**
 * Waits briefly for the PICKUP job on an order.
 *
 * THE DISPATCH IS FIRE-AND-FORGET BY DESIGN. `acceptOrder` commits the status
 * and then creates the rider job outside the request, so a dispatch problem
 * can never turn an accepted order into a failed API call -- the Sorter's own
 * dispatch does the same. The job therefore appears a moment AFTER the accept
 * responds, and asserting on it immediately is a race in the test rather than
 * a fault in the flow.
 */
async function waitForPickupJob(orderId: string, ms = 4000): Promise<any> {
  const until = Date.now() + ms;
  for (;;) {
    const job = (await query<any>(
      `SELECT id, order_id, job_type, status FROM rider_jobs
        WHERE order_id = ? AND job_type = 'PICKUP' LIMIT 1`,
      [orderId]
    )).rows[0];
    if (job || Date.now() > until) return job ?? null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Dapoli, inside the service area, so `requireServiceArea` lets the order through. */
const INSIDE = { latitude: 17.7590, longitude: 73.1890 };

async function main() {
  const created: string[] = [];
  /** Item weights this test overwrote, to be put back in the clean-up. */
  const originalWeights: Array<{ id: string; weight: unknown }> = [];

  const manager = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'MANAGER' AND is_active = 1 LIMIT 1`
  )).rows[0];
  if (!manager) throw new Error('No active MANAGER.');
  const managerToken = generateAccessToken({
    id: String(manager.id), email: manager.email || 'm@x.z', role: 'MANAGER',
  });

  const sorter = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'SORTER' AND is_active = 1 LIMIT 1`
  )).rows[0];
  const rider = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'RIDER' AND is_active = 1 LIMIT 1`
  )).rows[0];

  /* A customer with a saved address inside the service area. */
  const customer = (await query<any>(
    `SELECT u.id, u.mobile_number, a.id AS address_id
       FROM users u JOIN customer_addresses a ON a.user_id = u.id
      WHERE u.role = 'CUSTOMER' AND u.is_active = 1
      ORDER BY u.id DESC LIMIT 1`
  )).rows[0];
  if (!customer) throw new Error('No customer with a saved address.');
  const customerToken = generateAccessToken({
    id: String(customer.id), email: 'c@x.z', role: 'CUSTOMER',
    mobile_number: customer.mobile_number,
  } as any);

  try {
    /* ============================================================
     * 1. A REAL CUSTOMER BOOKING, THROUGH THE REAL API
     * ============================================================ */
    console.log('\n1. CUSTOMER BOOKS (POST /api/orders)');

    // Put something priced in the cart, through the cart API the app uses.
    /*
     * TWO DISTINCT ITEMS. An item priced for two services appears twice in
     * `customer_price_list`, and picking the same one twice merges into a
     * single cart line of double the quantity -- which is correct behaviour,
     * but makes the weight arithmetic below test something other than what it
     * says it does.
     */
    const priced = (await query<any>(
      `SELECT cp.item_id, MIN(cp.service_id) AS service_id, s.weight_kg
         FROM customer_price_list cp
         JOIN services s ON s.id = cp.item_id
        WHERE cp.is_active = 1 AND s.is_active = 1
        GROUP BY cp.item_id, s.weight_kg
        ORDER BY cp.item_id
        LIMIT 2`
    )).rows;
    if (priced.length === 0) throw new Error('No customer-priced item to order.');

    /*
     * GIVE THE TWO ITEMS A WEIGHT FOR THE DURATION OF THIS TEST.
     *
     * No CUSTOMER-scope item carries one today, so without this the weight
     * assertion below would compare 0 against an expected 0 and prove nothing
     * about the calculation. The original values are restored in the clean-up.
     */
    for (let i = 0; i < priced.length; i += 1) {
      originalWeights.push({ id: String(priced[i].item_id), weight: priced[i].weight_kg });
      priced[i].weight_kg = i === 0 ? 0.25 : 0.5;
      await query(
        `UPDATE services SET weight_kg = ? WHERE id = ?`,
        [priced[i].weight_kg, priced[i].item_id]
      );
    }

    // The cart API takes camelCase keys; `DELETE /api/cart` empties it.
    await api('/api/cart', customerToken, { method: 'DELETE' });
    for (const row of priced) {
      const added = await api('/api/cart/items', customerToken, {
        method: 'POST',
        body: {
          serviceId: String(row.item_id),
          quantity: 2,
          laundryServiceId: row.service_id ? String(row.service_id) : undefined,
        },
      });
      if (added.status >= 400) {
        throw new Error(`Could not add item ${row.item_id}: ${added.text.slice(0, 200)}`);
      }
    }

    const slots = await api(
      `/api/orders/time-slots?date=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
      customerToken
    );
    const slot = (slots.json?.data || []).find((s: any) => s.available);
    if (!slot) throw new Error('No bookable pickup slot.');
    const pickupDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const booked = await api('/api/orders', customerToken, {
      method: 'POST',
      body: {
        address_id: String(customer.address_id),
        pickup_date: pickupDate,
        pickup_slot_start: slot.start,
        pickup_slot_end: slot.end,
        payment_method: 'CASH_ON_DELIVERY',
        ...INSIDE,
      },
    });
    check('the booking is accepted by the API', booked.status === 201,
      `status ${booked.status} ${booked.json?.message ?? booked.text.slice(0, 120)}`);

    const orderId = String(booked.json?.data?.id ?? '');
    const orderNumber = String(booked.json?.data?.order_number ?? '');
    if (!orderId) throw new Error(`No order was created: ${booked.text.slice(0, 300)}`);
    created.push(orderId);
    console.log(`   order ${orderNumber} (id ${orderId})`);

    const stored = (await query<any>(
      `SELECT status, user_id, business_user_id, total_weight_kg FROM orders WHERE id = ?`,
      [orderId]
    )).rows[0];
    check('it is saved with the customer on it', String(stored.user_id) === String(customer.id));
    check('its status is PENDING_APPROVAL, not ORDER_PLACED',
      stored.status === 'PENDING_APPROVAL', stored.status);

    /* ---- the weight, from the items ---- */
    const expectedWeight = Number(
      priced.reduce(
        (sum: number, r: any) => sum + Number((Number(r.weight_kg ?? 0) * 2).toFixed(3)), 0
      ).toFixed(3)
    );
    // 0.25kg x 2 + 0.5kg x 2 = 1.5kg. A NON-ZERO total is the point: this
    // column was never written for a customer order at all.
    check('the weight is not zero, and both items and quantities counted',
      Number(stored.total_weight_kg) === 1.5 && expectedWeight === 1.5,
      `${stored.total_weight_kg} kg`);
    check('the order stored a weight computed from its items',
      Number(stored.total_weight_kg) === expectedWeight,
      `stored ${stored.total_weight_kg}, Σ(weight×qty) = ${expectedWeight}`);

    /* ============================================================
     * 2. IT IS NOT YET ON THE SHOP FLOOR
     * ============================================================ */
    console.log('\n2. BEFORE THE MANAGER ACCEPTS');

    if (sorter) {
      const sorterToken = generateAccessToken({
        id: String(sorter.id), email: sorter.email || 's@x.z', role: 'SORTER',
      });
      const queue = await api('/api/sorter/orders', sorterToken);
      const ids = (queue.json?.data?.orders ?? queue.json?.data ?? []).map((o: any) => String(o.id));
      check('the SORTER API does not list it', !ids.includes(orderId),
        `${ids.length} order(s) in the queue`);
    } else {
      console.log('  SKIP  no SORTER account');
    }

    const jobsBefore = (await query<any>(
      `SELECT COUNT(*) AS n FROM rider_jobs WHERE order_id = ?`, [orderId]
    )).rows[0].n;
    check('no rider job exists yet', Number(jobsBefore) === 0, `${jobsBefore} job(s)`);

    /* ============================================================
     * 3. IT IS IN THE MANAGER'S CUSTOMER TAB
     * ============================================================ */
    console.log('\n3. MANAGER — CUSTOMER REQUESTS');

    const tab = await api('/api/manager/order-requests/customer', managerToken);
    const row = (tab.json?.data || []).find((r: any) => String(r.id) === orderId);
    check('the booking appears in Customer Requests', !!row, `${(tab.json?.data || []).length} waiting`);
    check('and NOT in Business Requests',
      !((await api('/api/manager/order-requests/business', managerToken)).json?.data || [])
        .some((r: any) => String(r.id) === orderId));
    check('the row carries the order number the customer got',
      row?.order_number === orderNumber, `${row?.order_number}`);
    check('the row carries the weight',
      row?.total_weight_kg === (expectedWeight === 0 ? 0 : expectedWeight)
        || (expectedWeight === 0 && (row?.total_weight_kg === 0 || row?.total_weight_kg === null)),
      `${row?.total_weight_kg}`);

    /* ============================================================
     * 4. THE MANAGER ACCEPTS
     * ============================================================ */
    console.log('\n4. MANAGER ACCEPTS');

    const pickup = await pickupFor(managerToken);
    const accepted = await api(
      `/api/manager/order-requests/${orderId}/accept`, managerToken,
      { method: 'POST', body: pickup }
    );
    check('accept succeeds', accepted.status === 200, `status ${accepted.status}`);
    check('SAME order id back', String(accepted.json?.data?.id) === orderId);
    check('the pickup the manager assigned is stored on THAT order',
      (await query<any>(
        `SELECT DATE_FORMAT(assigned_pickup_date, '%Y-%m-%d') AS d FROM orders WHERE id = ?`,
        [orderId]
      )).rows[0].d === pickup.pickupDate);

    const after = (await query<any>(
      `SELECT status FROM orders WHERE id = ?`, [orderId]
    )).rows[0];
    check('the DATABASE now says ORDER_PLACED', after.status === 'ORDER_PLACED', after.status);

    /* ============================================================
     * 5. SORTER AND RIDER BOTH SEE THE SAME ORDER
     * ============================================================ */
    console.log('\n5. SORTER + RIDER');

    if (sorter) {
      const sorterToken = generateAccessToken({
        id: String(sorter.id), email: sorter.email || 's@x.z', role: 'SORTER',
      });
      const queue = await api('/api/sorter/orders', sorterToken);
      const ids = (queue.json?.data?.orders ?? queue.json?.data ?? []).map((o: any) => String(o.id));
      check('the SORTER API now lists the SAME order id', ids.includes(orderId),
        `${ids.length} order(s) in the queue`);
    }

    /*
     * THE RIDER. A job must now EXIST -- this is what the advisory alone
     * never did, and why the rider half of the flow was dead.
     */
    const job = await waitForPickupJob(orderId);
    check('a PICKUP rider job now exists for the order', !!job && job.job_type === 'PICKUP',
      job ? `job ${job.id} ${job.job_type} ${job.status}` : 'none');
    check('and it points at the SAME order id',
      job && String(job.order_id) === orderId, `${job?.order_id}`);

    if (rider && job) {
      const riderToken = generateAccessToken({
        id: String(rider.id), email: rider.email || 'r@x.z', role: 'RIDER',
      });
      const offers = await api('/api/rider/offers', riderToken);
      check('the RIDER offers endpoint answers', offers.status === 200, `status ${offers.status}`);
      // Whether THIS rider is offered depends on duty and distance, which is
      // the existing dispatch rule and not something to weaken here.
      console.log(`   rider offers visible to this rider: `
        + `${(offers.json?.data || []).length} (dispatch is duty/distance based)`);
    }

    /* ============================================================
     * 6. ONE ORDER, ONE ID, AND THE STATUS IS SHARED
     * ============================================================ */
    console.log('\n6. ONE ORDER THROUGHOUT');

    const dupes = (await query<any>(
      `SELECT COUNT(*) AS n FROM orders WHERE order_number = ?`, [orderNumber]
    )).rows[0].n;
    check('exactly one order carries that number', Number(dupes) === 1, `${dupes}`);

    const tracking = await api(`/api/orders/${orderId}/tracking`, customerToken);
    check('Track My Order shows the same order and status',
      String(tracking.json?.data?.id) === orderId
        && tracking.json?.data?.status === 'ORDER_PLACED',
      `${tracking.json?.data?.id} / ${tracking.json?.data?.status}`);

    const list = await api('/api/orders', customerToken);
    const mine = (list.json?.data?.orders || []).find((o: any) => String(o.id) === orderId);
    check('the customer Orders list shows the same status',
      mine?.status === 'ORDER_PLACED', mine?.status);

    check('it has left the Manager queue',
      !((await api('/api/manager/order-requests/customer', managerToken)).json?.data || [])
        .some((r: any) => String(r.id) === orderId));
    /* ============================================================
     * 7. THE BUSINESS LEG, THROUGH THE REAL BUSINESS API
     *
     * A business books through a different controller entirely
     * (`POST /api/businesses/orders`, its own cart), so passing the customer
     * leg says nothing about it. Same assertions, same chain.
     * ============================================================ */
    console.log('\n7. BUSINESS BOOKS (POST /api/businesses/orders)');

    const bizUser = (await query<any>(
      `SELECT bu.id, bu.business_id
         FROM business_users bu
         JOIN business_price_list p ON p.business_id = bu.business_id AND p.is_active = 1
        GROUP BY bu.id, bu.business_id
        ORDER BY COUNT(*) DESC LIMIT 1`
    )).rows[0];

    if (!bizUser) {
      console.log('  SKIP  no business user with a priced catalogue');
    } else {
      const bizToken = generateAccessToken({
        id: String(bizUser.id), email: 'b@x.z', role: 'BUSINESS',
      } as any);

      const bizItem = (await query<any>(
        `SELECT p.item_id, st.code AS service_code
           FROM business_price_list p
           JOIN item_service_types m ON m.item_id = p.item_id
           JOIN services st ON st.id = m.service_id AND st.kind = 'SERVICE_TYPE'
          WHERE p.business_id = ? AND p.laundry_type = 'hotel' AND p.is_active = 1
          LIMIT 1`,
        [bizUser.business_id]
      )).rows[0];

      if (!bizItem) {
        console.log('  SKIP  no priced business item with a service');
      } else {
        await api('/api/businesses/cart', bizToken, { method: 'DELETE' }).catch(() => undefined);
        /*
         * Laundry type and order type are chosen in the Cart, not on the
         * order, and the order is refused without them. The app sets these
         * from its own selector; this is the same call it makes.
         */
        const context = await api('/api/businesses/cart/context', bizToken, {
          method: 'PUT',
          body: { laundryType: 'hotel', orderType: 'standard' },
        });
        check('the business cart takes a laundry type', context.status < 400,
          `status ${context.status}`);

        const bizAdd = await api('/api/businesses/cart/items', bizToken, {
          method: 'POST',
          body: {
            itemId: String(bizItem.item_id),
            quantity: 3,
            itemServiceType: bizItem.service_code,
          },
        });
        check('a business item goes into the business cart', bizAdd.status < 400,
          `status ${bizAdd.status} ${bizAdd.text.slice(0, 120)}`);

        const bizSlots = await api(
          `/api/businesses/time-slots?date=${pickupDate}`, bizToken
        );
        const bizSlot = (bizSlots.json?.data?.slots ?? bizSlots.json?.data ?? [])
          .find((x: any) => x.available !== false);

        const bizBooked = await api('/api/businesses/orders', bizToken, {
          method: 'POST',
          body: {
            pickupDate,
            pickupSlot: bizSlot?.id ?? bizSlot?.value ?? bizSlot,
          },
        });
        check('the business booking is accepted', bizBooked.status === 201,
          `status ${bizBooked.status} ${bizBooked.json?.message ?? bizBooked.text.slice(0, 160)}`);

        const bizOrderId = String(bizBooked.json?.data?.id ?? '');
        if (bizOrderId) {
          created.push(bizOrderId);
          const bizStored = (await query<any>(
            `SELECT status, business_user_id FROM orders WHERE id = ?`, [bizOrderId]
          )).rows[0];
          check('the business order waits at PENDING_APPROVAL',
            bizStored.status === 'PENDING_APPROVAL', bizStored.status);

          const bizTab = await api('/api/manager/order-requests/business', managerToken);
          check('it appears in Business Requests',
            (bizTab.json?.data || []).some((r: any) => String(r.id) === bizOrderId));
          check('and NOT in Customer Requests',
            !((await api('/api/manager/order-requests/customer', managerToken)).json?.data || [])
              .some((r: any) => String(r.id) === bizOrderId));

          const bizAccept = await api(
            `/api/manager/order-requests/${bizOrderId}/accept`, managerToken,
            { method: 'POST', body: await pickupFor(managerToken) }
          );
          check('the manager accepts it', bizAccept.status === 200, `status ${bizAccept.status}`);
          check('it is reported as a BUSINESS order',
            bizAccept.json?.data?.source === 'BUSINESS', bizAccept.json?.data?.source);

          const bizAfter = (await query<any>(
            `SELECT status FROM orders WHERE id = ?`, [bizOrderId]
          )).rows[0];
          check('the database says ORDER_PLACED', bizAfter.status === 'ORDER_PLACED',
            bizAfter.status);

          const bizJob = await waitForPickupJob(bizOrderId);
          check('a PICKUP rider job exists for the SAME business order',
            !!bizJob && bizJob.job_type === 'PICKUP',
            bizJob ? `job ${bizJob.id}` : 'none');
        }
      }
    }
  } finally {
    console.log('\n8. CLEAN UP');
    // The item weights go back to exactly what they were.
    for (const row of originalWeights) {
      await query(`UPDATE services SET weight_kg = ? WHERE id = ?`, [row.weight, row.id]);
    }
    for (const id of created) {
      await query(`DELETE FROM rider_job_offers WHERE job_id IN (SELECT id FROM rider_jobs WHERE order_id = ?)`, [id]).catch(() => undefined);
      await query(`DELETE FROM rider_jobs WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM order_status_history WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM notifications WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM garments WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM order_items WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM pickups WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM deliveries WHERE order_id = ?`, [id]).catch(() => undefined);
      await query(`DELETE FROM orders WHERE id = ?`, [id]).catch(() => undefined);
    }
    const left = (await query<any>(
      `SELECT COUNT(*) AS n FROM orders WHERE id IN (${created.map(() => '?').join(',') || 'NULL'})`,
      created
    )).rows[0]?.n ?? 0;
    check('the test order is removed', Number(left) === 0, `${left} left`);

    const stillNull = originalWeights.length === 0 ? 0 : Number((await query<any>(
      `SELECT COUNT(*) AS n FROM services
        WHERE id IN (${originalWeights.map(() => '?').join(',')}) AND weight_kg IS NULL`,
      originalWeights.map((r) => r.id)
    )).rows[0].n);
    check('the catalogue weights are put back as they were',
      stillNull === originalWeights.filter((r) => r.weight === null).length,
      `${stillNull} of ${originalWeights.length} back to NULL`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
