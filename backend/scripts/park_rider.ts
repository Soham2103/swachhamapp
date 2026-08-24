/**
 * Puts a rider at a fixed position, on duty, with a fresh timestamp.
 *
 *   npx ts-node --transpile-only scripts/park_rider.ts 9000000012 17.7432938 73.1596835
 *
 * For riders that are NOT signed in on a phone. A rider using the app pings
 * their real position every twenty seconds and would overwrite anything set
 * here within the minute — for those, use EXPO_PUBLIC_RIDER_MOCK_LAT/LNG in
 * mobile/.env instead, which makes the app itself report a chosen point.
 *
 * The fresh `last_location_at` matters: dispatch ignores any fix older than
 * fifteen minutes, so a parked rider with a stale timestamp is invisible no
 * matter where they claim to be.
 */

import { pool, query } from '../src/config/database';

async function main() {
  const [mobile, latArg, lngArg] = process.argv.slice(2);

  if (!mobile || !latArg || !lngArg) {
    console.log('Usage: park_rider.ts <mobile> <latitude> <longitude>');
    await pool.end();
    return;
  }

  const latitude = Number(latArg);
  const longitude = Number(lngArg);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    console.log('Latitude and longitude must be numbers.');
    await pool.end();
    return;
  }

  const user = await query<any>(
    `SELECT id, name FROM users WHERE mobile_number = ? AND role = 'RIDER'`,
    [mobile]
  );
  if (user.rows.length === 0) {
    console.log(`No RIDER account with mobile ${mobile}.`);
    await pool.end();
    return;
  }

  const riderId = String(user.rows[0].id);
  await query(`INSERT IGNORE INTO rider_profiles (user_id) VALUES (?)`, [riderId]);
  await query(
    `UPDATE rider_profiles
        SET is_online = TRUE,
            went_online_at = COALESCE(went_online_at, NOW()),
            last_latitude = ?, last_longitude = ?, last_accuracy_m = 10,
            last_location_at = NOW()
      WHERE user_id = ?`,
    [latitude, longitude, riderId]
  );

  console.log(
    `${user.rows[0].name} (${mobile}) parked online at ${latitude}, ${longitude} with a fresh fix.`
  );
  await pool.end();
}

main().catch(async (error) => {
  console.error('FAILED:', error);
  await pool.end();
  process.exit(1);
});
