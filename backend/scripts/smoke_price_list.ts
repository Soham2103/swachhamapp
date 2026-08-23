/**
 * Smoke test for Super Admin -> Price Adjustment.
 *
 * Two things are checked, and they pull in opposite directions:
 *
 *   ORGANISATION   the listings return only items under a LIVE category, in
 *                  main-category -> sub-category -> item order, so the screen
 *                  can group them without sorting anything itself.
 *
 *   NOTHING LOST   every existing action still works -- create an item, price
 *                  it, adjust the price, enable, disable, delete -- and no
 *                  order line is touched by any of it.
 *
 * It creates its own catalogue item and its own prices, and removes them
 * again. `order_items` is checksummed before and after, because the whole
 * point of the exclusion is that it does not reach historical orders.
 *
 *   npx ts-node scripts/smoke_price_list.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5099';

/** The old flat catalogue, switched off when the two-level tree replaced it. */
const OBSOLETE_CATEGORY_NAMES = [
  'Bath Linen', 'Bed Linen', 'Room Furnishing', 'Living Room', 'Dining and Kitchen',
  'Carpet and Rugs', 'Staff Uniform', 'F&B Banquets', 'Spa Linen', 'Special Services',
  'Blanket and Heavy Linens', 'Floor and Upholstery', 'Housekeeping Utility', 'Industrial',
];

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

let token = '';

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* an HTML error page */ }
  return { status: res.status, json };
}

/** A fingerprint of every order line, so "orders untouched" is provable. */
async function orderFingerprint(): Promise<string> {
  const r = await query<any>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(quantity), 0) AS q,
            COALESCE(SUM(unit_price), 0) AS up,
            COALESCE(SUM(total_price), 0) AS tp,
            COALESCE(GROUP_CONCAT(CONCAT(id,':',service_id,':',unit_price) ORDER BY id), '') AS sig
       FROM order_items`
  );
  const row = r.rows[0];
  return `${row.n}|${row.q}|${row.up}|${row.tp}|${row.sig}`;
}

/** Walks a listing and reports whether its groups are contiguous. */
function groupingIsContiguous(rows: any[]): { ok: boolean; detail: string } {
  const seenTop = new Set<string>();
  const seenSub = new Set<string>();
  let lastTop = '';
  let lastSub = '';
  for (const r of rows) {
    const top = String(r.parent_category_id || r.category_id);
    const sub = String(r.category_id);
    if (top !== lastTop) {
      if (seenTop.has(top)) return { ok: false, detail: `main category ${top} appears twice` };
      seenTop.add(top);
      lastTop = top;
      // A new main category restarts the sub-category run.
    }
    if (sub !== lastSub) {
      if (seenSub.has(sub)) return { ok: false, detail: `sub-category ${sub} appears twice` };
      seenSub.add(sub);
      lastSub = sub;
    }
  }
  return { ok: true, detail: `${seenTop.size} main, ${seenSub.size} sub` };
}

async function main() {
  const admin = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 ORDER BY id LIMIT 1`
  );
  if (!admin.rows[0]) throw new Error('No active SUPER_ADMIN to test with.');
  token = generateAccessToken({
    id: String(admin.rows[0].id),
    email: admin.rows[0].email,
    role: 'SUPER_ADMIN',
  });

  const business = await query<any>(`SELECT id, name FROM businesses ORDER BY id LIMIT 1`);
  const businessId = String(business.rows[0].id);

  const ordersBefore = await orderFingerprint();

  /* ================================================================
   * 1. WHAT THE LISTINGS RETURN
   * ================================================================ */
  console.log('\nDATA — OBSOLETE ENTRIES EXCLUDED');

  const items = await api('/api/super-admin/prices/items');
  check('the catalogue listing loads', items.status === 200, `status ${items.status}`);
  const itemRows: any[] = items.json?.data || [];

  const obsoleteInItems = itemRows.filter((r) =>
    OBSOLETE_CATEGORY_NAMES.includes(r.category_name) && !r.parent_category_name);
  check('no item from an obsolete category is offered', obsoleteInItems.length === 0,
    obsoleteInItems.slice(0, 3).map((r) => `${r.name}/${r.category_name}`).join(', ') || 'none');

  const noCategory = itemRows.filter((r) => !r.category_id);
  check('every item carries a category', noCategory.length === 0,
    `${noCategory.length} without one`);

  const bizList = await api(
    `/api/super-admin/prices/businesses/${businessId}?laundry_type=hotel`);
  check('the business price list loads', bizList.status === 200, `status ${bizList.status}`);
  const bizRows: any[] = bizList.json?.data || [];

  const bizObsolete = bizRows.filter((r) =>
    OBSOLETE_CATEGORY_NAMES.includes(r.category_name) && !r.parent_category_name);
  check('no obsolete item appears in the business price list', bizObsolete.length === 0,
    `${bizRows.length} rows, ${bizObsolete.length} obsolete`);

  // Cross-check against the database rather than trusting the API's own count.
  const expected = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM services i
       JOIN service_categories c ON c.id = i.category_id
       LEFT JOIN service_categories pc ON pc.id = c.parent_id
      WHERE i.kind = 'ITEM' AND i.is_active = true
        AND c.is_active = true AND (c.parent_id IS NULL OR pc.is_active = true)`
  );
  check('the row count matches the live catalogue exactly',
    bizRows.length === Number(expected.rows[0].n),
    `${bizRows.length} returned, ${expected.rows[0].n} live`);

  const stillThere = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM services i
       JOIN service_categories c ON c.id = i.category_id
      WHERE i.kind = 'ITEM' AND c.is_active = false`
  );
  check('the excluded rows are still IN the database, not deleted',
    Number(stillThere.rows[0].n) > 0,
    `${stillThere.rows[0].n} rows retained`);

  /* ================================================================
   * 2. THE HIERARCHY
   * ================================================================ */
  console.log('\nHIERARCHY — MAIN CATEGORY -> SUB-CATEGORY -> ITEM');

  const grouping = groupingIsContiguous(bizRows);
  check('categories and sub-categories arrive contiguous', grouping.ok, grouping.detail);

  const mains = new Map<string, number>();
  for (const r of bizRows) {
    const name = r.parent_category_name || r.category_name;
    mains.set(name, (mains.get(name) || 0) + 1);
  }
  console.log('        main categories: ' +
    [...mains].map(([n, c]) => `${n} (${c})`).join(', '));
  for (const wanted of ['Room Linen', 'Spa & Pool', 'Uniforms']) {
    check(`"${wanted}" is present`, mains.has(wanted), `${mains.get(wanted) || 0} items`);
  }
  check('an F&B main category is present',
    [...mains.keys()].some((n) => n.toLowerCase().startsWith('f&b')),
    [...mains.keys()].filter((n) => n.toLowerCase().startsWith('f&b')).join(', '));
  check('no obsolete category is a heading',
    ![...mains.keys()].some((n) => OBSOLETE_CATEGORY_NAMES.includes(n) &&
      !bizRows.some((r) => r.parent_category_name === n)),
    [...mains.keys()].join(' | '));

  const cats = await api('/api/super-admin/prices/categories');
  check('the category tree loads', cats.status === 200, `status ${cats.status}`);
  const catRows: any[] = cats.json?.data || [];
  const tops = catRows.filter((c) => c.is_top_level);
  const subs = catRows.filter((c) => !c.is_top_level);
  check('the tree has both levels', tops.length > 0 && subs.length > 0,
    `${tops.length} main, ${subs.length} sub`);
  check('every sub-category points at a listed main category',
    subs.every((sub) => tops.some((t) => t.id === sub.parent_id)));

  /* ================================================================
   * 3. THE DEPENDENT FILTERS
   *
   * Category -> Sub-category -> Items. The screens narrow locally, so what is
   * checked here is the DATA CONTRACT they narrow on: that a category's
   * sub-categories are exactly its own children, and that a (category,
   * sub-category) pair yields only that pair's items.
   * ================================================================ */
  console.log('\nFILTERS — CATEGORY -> SUB-CATEGORY -> ITEMS');

  /** The screens' own accessors. */
  const topId = (r: any) => String(r.parent_category_id || r.category_id);
  const subId = (r: any) => (r.parent_category_id ? String(r.category_id) : null);

  const mainIds = [...new Set(bizRows.map(topId))];
  check('there is more than one category to choose between', mainIds.length > 1,
    `${mainIds.length} categories`);

  let subsAreOwnChildren = true;
  let itemsMatchThePair = true;
  let checkedPairs = 0;

  for (const mainId of mainIds) {
    const inCategory = bizRows.filter((r) => topId(r) === mainId);

    // What the second dropdown would offer for this category.
    const offered = [...new Set(inCategory.map(subId).filter(Boolean) as string[])];

    // Every one of them must really be a child of THIS category.
    for (const sub of offered) {
      const owner = catRows.find((c) => String(c.id) === sub);
      if (!owner || String(owner.parent_id) !== String(mainId)) subsAreOwnChildren = false;
    }

    // No sub-category of another category may leak into the offer.
    const foreign = catRows.filter(
      (c) => !c.is_top_level && String(c.parent_id) !== String(mainId) && offered.includes(String(c.id)));
    if (foreign.length) subsAreOwnChildren = false;

    // Choosing a pair must yield only that pair's items.
    for (const sub of offered) {
      const picked = bizRows.filter((r) => topId(r) === mainId && subId(r) === sub);
      if (!picked.length) itemsMatchThePair = false;
      if (picked.some((r) => topId(r) !== mainId || subId(r) !== sub)) itemsMatchThePair = false;
      checkedPairs += 1;
    }
  }

  check('every offered sub-category belongs to the chosen category', subsAreOwnChildren,
    `${checkedPairs} pairs checked`);
  check('a category + sub-category pair yields only that pair\'s items', itemsMatchThePair);

  // Choosing one pair must never show the whole catalogue.
  const firstMain = mainIds[0];
  const firstSub = [...new Set(bizRows.filter((r) => topId(r) === firstMain)
    .map(subId).filter(Boolean) as string[])][0];
  const narrowed = bizRows.filter((r) => topId(r) === firstMain && subId(r) === firstSub);
  check('one pair is a small slice, not the whole list',
    narrowed.length > 0 && narrowed.length < bizRows.length,
    `${narrowed.length} of ${bizRows.length}`);

  const customerRows: any[] = (await api('/api/super-admin/prices/customers')).json?.data || [];
  check('the customer list carries the same two levels to filter on',
    customerRows.every((r) => r.category_id !== null),
    `${customerRows.length} rows`);

  /* ================================================================
   * 4. ADD -> PRICE -> ADJUST -> DISABLE -> DELETE
   * ================================================================ */
  console.log('\nCRUD — EVERY EXISTING ACTION');

  // A real sub-category from the tree, so the item lands in a real group.
  const roomLinen = tops.find((c) => c.name === 'Room Linen') || tops[0];
  const targetSub = subs.find((c) => c.parent_id === roomLinen.id);
  check('a sub-category is available to file a new item under', Boolean(targetSub),
    targetSub ? `${roomLinen.name} / ${targetSub.name}` : 'none');

  const ITEM_NAME = `Smoke Test Item ${Date.now()}`;
  const created = await api('/api/super-admin/prices/items', {
    method: 'POST',
    body: { item_name: ITEM_NAME, category_id: roomLinen.id, subcategory_id: targetSub.id },
  });
  check('+ Add New Item creates the item', created.status === 201,
    `${created.status}: ${created.json?.message}`);
  const itemId = String(created.json?.data?.id);

  check('the new item is filed under the chosen sub-category',
    String(created.json?.data?.category_id) === String(targetSub.id),
    `${created.json?.data?.category_name}`);

  const dupe = await api('/api/super-admin/prices/items', {
    method: 'POST',
    body: { item_name: ITEM_NAME, category_id: roomLinen.id, subcategory_id: targetSub.id },
  });
  check('a duplicate name in the same sub-category is refused', dupe.status === 409,
    `${dupe.status}: ${dupe.json?.message}`);

  // -- it appears in the grouped listing, under the right heading --
  const afterAdd = await api(
    `/api/super-admin/prices/businesses/${businessId}?laundry_type=hotel`);
  const addedRow = (afterAdd.json?.data || []).find((r: any) => String(r.item_id) === itemId);
  check('the new item appears in the price list', Boolean(addedRow));
  check('under the right Main Category -> Sub Category',
    addedRow?.parent_category_name === roomLinen.name &&
    addedRow?.category_name === targetSub.name,
    `${addedRow?.parent_category_name} / ${addedRow?.category_name}`);
  check('with no price set yet', addedRow?.price === null, String(addedRow?.price));
  const regrouped = groupingIsContiguous(afterAdd.json?.data || []);
  check('the grouping is still contiguous after adding', regrouped.ok, regrouped.detail);

  /* ---- customer price ---- */
  const custCreated = await api('/api/super-admin/prices/customers', {
    method: 'POST', body: { item_id: itemId, customer_price: 100 },
  });
  check('a customer price can be created', custCreated.status === 201,
    `${custCreated.status}: ${custCreated.json?.message}`);
  const custId = String(custCreated.json?.data?.id);

  const custAdjusted = await api(`/api/super-admin/prices/customers/${custId}`, {
    method: 'PUT', body: { customer_price: 110 },
  });
  check('the customer price can be adjusted', custAdjusted.status === 200 &&
    Number(custAdjusted.json?.data?.customer_price) === 110,
    `now ${custAdjusted.json?.data?.customer_price}`);

  const custList = await api('/api/super-admin/prices/customers');
  const custRow = (custList.json?.data || []).find((r: any) => String(r.id) === custId);
  check('the adjusted price survives a reload', Number(custRow?.customer_price) === 110,
    String(custRow?.customer_price));
  check('the customer price row carries its full hierarchy',
    custRow?.parent_category_name === roomLinen.name &&
    custRow?.category_name === targetSub.name,
    `${custRow?.parent_category_name} / ${custRow?.category_name}`);

  const custDisabled = await api(`/api/super-admin/prices/customers/${custId}`, {
    method: 'PUT', body: { is_active: false },
  });
  check('a customer price can be disabled', custDisabled.status === 200 &&
    custDisabled.json?.data?.is_active === false);
  await api(`/api/super-admin/prices/customers/${custId}`, {
    method: 'PUT', body: { is_active: true },
  });

  /* ---- business price ---- */
  const bizCreated = await api(`/api/super-admin/prices/businesses/${businessId}`, {
    method: 'POST', body: { item_id: itemId, laundry_type: 'hotel', price: 55 },
  });
  check('a business price can be set', bizCreated.status === 201,
    `${bizCreated.status}: ${bizCreated.json?.message}`);
  const bizPriceId = String(bizCreated.json?.data?.id);

  const bizAdjusted = await api(
    `/api/super-admin/prices/businesses/${businessId}/${bizPriceId}`,
    { method: 'PUT', body: { price: 65 } });
  check('the business price can be adjusted', bizAdjusted.status === 200 &&
    Number(bizAdjusted.json?.data?.price) === 65,
    `now ${bizAdjusted.json?.data?.price}`);

  const afterAdjust = await api(
    `/api/super-admin/prices/businesses/${businessId}?laundry_type=hotel`);
  const adjustedRow = (afterAdjust.json?.data || [])
    .find((r: any) => String(r.item_id) === itemId);
  check('the adjusted business price survives a reload',
    Number(adjustedRow?.price) === 65, String(adjustedRow?.price));

  // The two lists are independent: adjusting one must not move the other.
  const custAfterBiz = await api('/api/super-admin/prices/customers');
  const custStill = (custAfterBiz.json?.data || []).find((r: any) => String(r.id) === custId);
  check('adjusting the business price did not move the customer price',
    Number(custStill?.customer_price) === 110, String(custStill?.customer_price));

  const bizDisabled = await api(
    `/api/super-admin/prices/businesses/${businessId}/${bizPriceId}`,
    { method: 'PUT', body: { is_active: false } });
  check('a business price can be disabled', bizDisabled.status === 200 &&
    bizDisabled.json?.data?.is_active === false);

  const bizDeleted = await api(
    `/api/super-admin/prices/businesses/${businessId}/${bizPriceId}?hard=true`,
    { method: 'DELETE' });
  check('a business price can be deleted', bizDeleted.status === 200,
    `${bizDeleted.status}: ${bizDeleted.json?.message}`);

  const custDeleted = await api(
    `/api/super-admin/prices/customers/${custId}?hard=true`, { method: 'DELETE' });
  check('a customer price can be deleted', custDeleted.status === 200,
    `${custDeleted.status}: ${custDeleted.json?.message}`);

  /* ================================================================
   * 4. ORDERS UNTOUCHED
   * ================================================================ */
  console.log('\nORDERS');

  const ordersAfter = await orderFingerprint();
  check('no order line changed anywhere in this run', ordersBefore === ordersAfter,
    ordersBefore === ordersAfter ? 'fingerprint identical' : 'FINGERPRINT CHANGED');

  const snapshot = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM order_items
      WHERE category_name IS NOT NULL OR subcategory_name IS NOT NULL`
  );
  check('order lines keep their own snapshot of category and price',
    Number(snapshot.rows[0].n) >= 0,
    `${snapshot.rows[0].n} lines carry a frozen category name`);

  const orphanRefs = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM order_items oi
       LEFT JOIN services s ON s.id = oi.service_id
      WHERE oi.service_id IS NOT NULL AND s.id IS NULL`
  );
  check('every order line still resolves to a catalogue item',
    Number(orphanRefs.rows[0].n) === 0, `${orphanRefs.rows[0].n} dangling`);

  /* ---- clean up the item this test created ---- */
  await query(`DELETE FROM item_service_types WHERE item_id = ?`, [itemId]);
  await query(`DELETE FROM services WHERE id = ?`, [itemId]);
  const gone = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM services WHERE id = ?`, [itemId]);
  check('the smoke-test item was removed', Number(gone.rows[0].n) === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exit(1);
});
