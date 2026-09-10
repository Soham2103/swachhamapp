/**
 * Prints the handover code for rider jobs.
 *
 * WHY THIS EXISTS. The code is generated when a job is created and is shown
 * to the other party — the customer's notification, the hotel's Pickup
 * Approvals message, and now a push notification. On a developer's machine
 * none of those may be reachable, and the console line that carries it
 * scrolls away every time `ts-node-dev` respawns on a file save. Reading it
 * out of the database is the one way that always works.
 *
 * Read-only. Sends nothing, changes nothing.
 *
 * Usage:
 *   npm run job:code                 every job currently being worked
 *   npm run job:code -- 141          one job by id
 *   npm run job:code -- SWH#1109...  every job on one order number
 */
require('dotenv').config();
const path = require('path');

require(path.join(__dirname, '..', 'node_modules', 'ts-node')).register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { query } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

const arg = process.argv[2];

const ACTIVE = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'COLLECTED'];

function line(label, value) {
  console.log('     ' + String(label).padEnd(12) + value);
}

(async () => {
  let sql = `
    SELECT rj.id, rj.job_type, rj.status, rj.handover_code, rj.arrived_at,
           rj.door_acceptance_mode, rj.accepted_piece_count,
           o.order_number, o.business_user_id, u.name AS rider
      FROM rider_jobs rj
      JOIN orders o ON o.id = rj.order_id
      LEFT JOIN users u ON u.id = rj.rider_id`;
  const params = [];

  if (!arg) {
    sql += ` WHERE rj.status IN (${ACTIVE.map(() => '?').join(',')})`;
    params.push(...ACTIVE);
  } else if (/^\d+$/.test(arg)) {
    sql += ' WHERE rj.id = ?';
    params.push(arg);
  } else {
    sql += ' WHERE o.order_number = ?';
    params.push(arg);
  }
  sql += ' ORDER BY rj.id DESC';

  const result = await query(sql, params);

  if (!result.rows.length) {
    console.log(
      arg
        ? `\nNothing found for "${arg}".`
        : '\nNo job is currently being worked. Pass a job id or an order number to look one up.'
    );
    process.exit(0);
  }

  console.log('\nHANDOVER CODES (' + result.rows.length + ')\n');
  result.rows.forEach((r) => {
    // DISPATCH in the operation's vocabulary; the stored type is DELIVERY.
    const label = r.job_type === 'PICKUP' ? 'PICKUP' : 'DISPATCH';
    console.log(`  job ${r.id}  ${label}  ${r.status}`);
    line('order', r.order_number);
    line('rider', r.rider || '(unassigned)');
    line('CODE', r.handover_code || '(none)');
    if (r.business_user_id) {
      line(
        'accepted',
        r.door_acceptance_mode
          ? r.door_acceptance_mode +
              (r.accepted_piece_count ? ` (${r.accepted_piece_count} pieces)` : '')
          : 'NOT YET — the rider must complete Accept Order first'
      );
    }
    line(
      'usable',
      r.status === 'ARRIVED'
        ? 'YES — enter it now'
        : `not yet, the job is ${r.status} (the code is entered at ARRIVED)`
    );
    console.log('');
  });

  process.exit(0);
})().catch((error) => {
  console.error('job:code failed: ' + error.message);
  process.exit(1);
});
