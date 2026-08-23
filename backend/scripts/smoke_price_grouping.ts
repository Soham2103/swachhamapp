/**
 * What the Price Adjustment screen will actually draw.
 *
 * Runs the app's OWN grouping function -- `mobile/src/screens/superadmin/
 * priceGrouping.ts`, the same module the screens import -- over the rows the
 * real API returns, and prints the tree. So the structure checked here is the
 * structure rendered, not a re-implementation of it that could agree with the
 * screen by luck and disagree by accident.
 *
 * The import reaches into the mobile app, which is a sibling project, so
 * ts-node needs a rootDir that spans both:
 *
 *   npx ts-node --compiler-options '{"rootDir":"..","module":"commonjs"}' scripts/smoke_price_grouping.ts
 */
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import {
  buildGroups,
  NO_SUBCATEGORY_LABEL,
} from '../../mobile/src/screens/superadmin/priceGrouping';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5099';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

interface Row {
  item_id?: string;
  id?: string;
  item_name: string;
  category_id: string | null;
  category_name: string | null;
  parent_category_id: string | null;
  parent_category_name: string | null;
  price?: number | null;
  customer_price?: number | null;
}

/** Exactly the accessors SuperAdminBusinessPricesScreen passes. */
const ACCESSORS = {
  topIdOf: (r: Row) => r.parent_category_id || r.category_id,
  topNameOf: (r: Row) => r.parent_category_name || r.category_name,
  subIdOf: (r: Row) => (r.parent_category_id ? r.category_id : null),
  subNameOf: (r: Row) => (r.parent_category_id ? r.category_name : null),
};

async function main() {
  const admin = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 ORDER BY id LIMIT 1`
  );
  const token = generateAccessToken({
    id: String(admin.rows[0].id), email: admin.rows[0].email, role: 'SUPER_ADMIN',
  });
  const businessRow = await query<any>(`SELECT id, name FROM businesses ORDER BY id LIMIT 1`);
  const businessId = String(businessRow.rows[0].id);

  const res = await fetch(
    `${BASE}/api/super-admin/prices/businesses/${businessId}?laundry_type=hotel`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const body: any = await res.json();
  const rows: Row[] = body.data;

  const groups = buildGroups(rows, ACCESSORS);

  console.log(`\nPRICE ADJUSTMENT — ${businessRow.rows[0].name}, Hotel Laundry\n`);
  for (const g of groups) {
    console.log(`${g.name.toUpperCase()}  (${g.count} items)`);
    g.subgroups.forEach((sub, si) => {
      const lastSub = si === g.subgroups.length - 1;
      console.log(`   ${lastSub ? '└──' : '├──'} ${sub.name}  (${sub.items.length})`);
      sub.items.slice(0, 3).forEach((item, ii) => {
        const lastItem = ii === Math.min(sub.items.length, 3) - 1 && sub.items.length <= 3;
        const stem = lastSub ? '       ' : '   │   ';
        const money = item.price === null || item.price === undefined
          ? 'not set' : `₹${Number(item.price).toFixed(2)}`;
        console.log(`${stem}${lastItem ? '└─' : '├─'} ${item.item_name.padEnd(34)} ${money}`);
      });
      if (sub.items.length > 3) {
        const stem = lastSub ? '       ' : '   │   ';
        console.log(`${stem}└─ …and ${sub.items.length - 3} more`);
      }
    });
    console.log('');
  }

  /* ---- what the tree must satisfy ---- */
  console.log('CHECKS');

  check('the list is not flat', groups.length > 1 && groups.some((g) => g.subgroups.length > 1),
    `${groups.length} main categories`);

  const totalGrouped = groups.reduce((n, g) => n + g.count, 0);
  check('every row landed in a group', totalGrouped === rows.length,
    `${totalGrouped} of ${rows.length}`);

  const dupMain = groups.length !== new Set(groups.map((g) => g.key)).size;
  check('no main category appears twice', !dupMain);

  const dupSub = groups.some(
    (g) => g.subgroups.length !== new Set(g.subgroups.map((s) => s.key)).size);
  check('no sub-category appears twice inside a category', !dupSub);

  check('no group is empty',
    groups.every((g) => g.count > 0 && g.subgroups.every((s) => s.items.length > 0)));

  const orphanGroups = groups.flatMap((g) =>
    g.subgroups.filter((s) => s.name === NO_SUBCATEGORY_LABEL)
      .map((s) => `${g.name}: ${s.items.map((i) => i.item_name).join(', ')}`));
  check('items with no sub-category are shown, not dropped',
    orphanGroups.every((label) => label.length > 0),
    orphanGroups.length ? orphanGroups.join(' | ') : 'none in the catalogue');

  const names = groups.map((g) => g.name);
  for (const wanted of ['Room Linen', 'Spa & Pool', 'Uniforms']) {
    check(`"${wanted}" is a main category`, names.includes(wanted));
  }
  check('an F&B main category is present',
    names.some((n) => n.toLowerCase().startsWith('f&b')),
    names.filter((n) => n.toLowerCase().startsWith('f&b')).join(', '));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exit(1);
});
