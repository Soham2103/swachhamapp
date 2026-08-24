import { getClient, query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import socketService from './socket.service';
import { createNotification } from './notification.service';
import {
  dispatchJob,
  expireStaleOffers,
  reclaimStaleHolds,
  redispatchStaleJobs,
  formatDistance,
  getJobById,
  HOLD_MAX_MINUTES,
} from './dispatch.service';

/**
 * ===================================================================
 * RIDER — the rider's own side of the pickup and delivery leg
 * ===================================================================
 *
 * Dispatch decides WHO gets offered what. This file is everything the
 * rider does with what they were given: going on duty, sending a
 * position, working a job from accepted to handed over, and reading
 * their own day back.
 *
 * WHAT A RIDER IS NEVER SHOWN
 *
 * No prices, no totals, no invoice or payment position — the same rule
 * the Sorter module states and for the same reason. A rider carries
 * bags; what the bags are worth changes nothing they do, and a field
 * that is never selected cannot leak from a network tab. The one money
 * question a rider CAN have — cash to collect on delivery — is answered
 * with a single amount on the job, not with the order's billing.
 */

/** A rider stops being dispatched to after this long without a position. */
const STALE_FIX_MINUTES = 15;

/** Jobs that still count as "on the rider's plate". */
const ACTIVE_STATUSES = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'COLLECTED'];

export interface RiderProfile {
  user_id: string;
  name: string | null;
  mobile_number: string | null;
  vehicle_type: string;
  vehicle_number: string | null;
  license_number: string | null;
  is_online: boolean;
  last_latitude: number | null;
  last_longitude: number | null;
  last_location_at: Date | null;
  active_job_count: number;
  max_active_jobs: number;
  completed_jobs: number;
  cancelled_jobs: number;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the rider's profile, creating it on first sight.
 *
 * A RIDER account is made by a Manager or Super Admin through the creation
 * request flow, which writes a `users` row and nothing else — it has no idea
 * this module exists. Rather than have every caller cope with a missing
 * profile, the first read makes one with sane defaults.
 */
async function getOrCreateProfile(riderId: string): Promise<RiderProfile> {
  const existing = await query<any>(
    `SELECT rp.*, u.name, u.mobile_number, u.role
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.user_id = ?`,
    [riderId]
  );

  if (existing.rows.length > 0) return mapProfile(existing.rows[0]);

  const user = await query<any>(`SELECT id, name, mobile_number, role FROM users WHERE id = ?`, [
    riderId,
  ]);
  if (user.rows.length === 0) throw new AppError('Rider account not found', 404);
  if (user.rows[0].role !== 'RIDER') {
    throw new AppError('This account is not a rider account', 403);
  }

  await query(`INSERT IGNORE INTO rider_profiles (user_id) VALUES (?)`, [riderId]);
  logger.info(`[Rider] Created profile for rider ${riderId} on first sign-in`);

  const created = await query<any>(
    `SELECT rp.*, u.name, u.mobile_number
       FROM rider_profiles rp JOIN users u ON u.id = rp.user_id
      WHERE rp.user_id = ?`,
    [riderId]
  );
  return mapProfile(created.rows[0]);
}

function mapProfile(row: any): RiderProfile {
  return {
    user_id: String(row.user_id),
    name: row.name || null,
    mobile_number: row.mobile_number || null,
    vehicle_type: row.vehicle_type,
    vehicle_number: row.vehicle_number || null,
    license_number: row.license_number || null,
    is_online: Boolean(row.is_online),
    last_latitude: toNum(row.last_latitude),
    last_longitude: toNum(row.last_longitude),
    last_location_at: row.last_location_at || null,
    active_job_count: Number(row.active_job_count || 0),
    max_active_jobs: Number(row.max_active_jobs || 3),
    completed_jobs: Number(row.completed_jobs || 0),
    cancelled_jobs: Number(row.cancelled_jobs || 0),
  };
}

async function updateProfile(
  riderId: string,
  input: { vehicle_type?: string; vehicle_number?: string; license_number?: string }
): Promise<RiderProfile> {
  await getOrCreateProfile(riderId);

  const allowedVehicles = ['BIKE', 'SCOOTER', 'CYCLE', 'VAN', 'OTHER'];
  if (input.vehicle_type && !allowedVehicles.includes(input.vehicle_type)) {
    throw new AppError(`vehicle_type must be one of ${allowedVehicles.join(', ')}`, 400);
  }

  await query(
    `UPDATE rider_profiles
        SET vehicle_type   = COALESCE(?, vehicle_type),
            vehicle_number = COALESCE(?, vehicle_number),
            license_number = COALESCE(?, license_number)
      WHERE user_id = ?`,
    [
      input.vehicle_type || null,
      input.vehicle_number || null,
      input.license_number || null,
      riderId,
    ]
  );

  return getOrCreateProfile(riderId);
}

/**
 * On or off duty.
 *
 * Going ONLINE requires a position in the same call. A rider who is online
 * with no coordinates is invisible to dispatch anyway — they pass the duty
 * filter and then fail the distance one — so accepting the switch without a
 * fix would only produce a rider who believes they are working and never
 * hears from anyone.
 */
async function setOnlineStatus(
  riderId: string,
  online: boolean,
  location?: { latitude: number; longitude: number; accuracy?: number }
): Promise<RiderProfile> {
  await getOrCreateProfile(riderId);

  if (online) {
    if (
      !location ||
      !Number.isFinite(Number(location.latitude)) ||
      !Number.isFinite(Number(location.longitude))
    ) {
      throw new AppError(
        'Your location is required to go online, so pickups near you can be offered.',
        428
      );
    }
    await query(
      `UPDATE rider_profiles
          SET is_online = TRUE, went_online_at = NOW(),
              last_latitude = ?, last_longitude = ?, last_accuracy_m = ?, last_location_at = NOW()
        WHERE user_id = ?`,
      [
        location.latitude,
        location.longitude,
        Number.isFinite(Number(location.accuracy)) ? Math.round(Number(location.accuracy)) : null,
        riderId,
      ]
    );
    logger.info(`[Rider] Rider ${riderId} went online`);
  } else {
    await query(
      `UPDATE rider_profiles SET is_online = FALSE, went_online_at = NULL WHERE user_id = ?`,
      [riderId]
    );
    logger.info(`[Rider] Rider ${riderId} went offline`);
  }

  return getOrCreateProfile(riderId);
}

/**
 * A position ping while on duty.
 *
 * Also pushes the position into the order room of every job the rider is
 * carrying, which is what makes the customer's tracking screen move. Only
 * jobs in flight are broadcast — a completed order stops being interesting
 * and should not keep receiving a rider's whereabouts.
 */
async function updateLocation(
  riderId: string,
  latitude: number,
  longitude: number,
  accuracy?: number
): Promise<{ updated: boolean; broadcastTo: number }> {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    throw new AppError('latitude and longitude are required numbers', 400);
  }

  await getOrCreateProfile(riderId);

  await query(
    `UPDATE rider_profiles
        SET last_latitude = ?, last_longitude = ?, last_accuracy_m = ?, last_location_at = NOW()
      WHERE user_id = ?`,
    [
      latitude,
      longitude,
      Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null,
      riderId,
    ]
  );

  const active = await query<any>(
    `SELECT order_id FROM rider_jobs
      WHERE rider_id = ? AND status IN ('ASSIGNED','EN_ROUTE','ARRIVED')`,
    [riderId]
  );

  for (const row of active.rows) {
    socketService.emitRiderLocation(String(row.order_id), {
      orderId: String(row.order_id),
      riderId,
      latitude,
      longitude,
      at: new Date().toISOString(),
    });
  }

  return { updated: true, broadcastTo: active.rows.length };
}

/**
 * The offers currently sitting with this rider.
 *
 * Lapsed offers are swept first, so a rider who opens the app after a break
 * does not see a countdown that ran out twenty minutes ago.
 */
async function listOffers(riderId: string): Promise<any[]> {
  /*
   * Three sweeps, run here because this is the call that happens often and
   * the project has no scheduler: lapse offers nobody answered, take back
   * holds that were sat on, and put jobs whose offers all expired back in
   * front of somebody.
   */
  await expireStaleOffers();
  await reclaimStaleHolds();
  await redispatchStaleJobs();

  /*
   * THE COUNTDOWN IS COMPUTED BY THE DATABASE, as a number of seconds.
   *
   * Handing the app the expires_at DATETIME made it depend on two timezone
   * conversions agreeing: mysql2 reading the column in the server process's
   * zone, then the phone parsing the result against its own clock. A plain
   * duration cannot be misread by either.
   */
  const result = await query<any>(
    `SELECT rjo.id AS offer_id, rjo.distance_m, rjo.offered_at,
            GREATEST(TIMESTAMPDIFF(SECOND, NOW(), rjo.expires_at), 0) AS expires_in_seconds,
            rj.id AS job_id, rj.job_type, rj.status AS job_status,
            COALESCE(o.total_weight_kg, 0) AS total_weight_kg,
            rj.address_text, rj.contact_name, rj.latitude, rj.longitude,
            rj.origin_address, rj.origin_latitude, rj.origin_longitude,
            o.id AS order_id, o.order_number,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM rider_job_offers rjo
       JOIN rider_jobs rj ON rj.id = rjo.job_id
       JOIN orders o      ON o.id = rj.order_id
      WHERE rjo.rider_id = ?
        AND rjo.status = 'OFFERED'
        AND rj.status = 'OFFERED'
      ORDER BY rjo.distance_m ASC`,
    [riderId]
  );

  return result.rows.map((r) => ({
    offer_id: String(r.offer_id),
    job_id: String(r.job_id),
    order_id: String(r.order_id),
    order_number: r.order_number,
    job_type: r.job_type,
    address_text: r.address_text,
    contact_name: r.contact_name,
    latitude: toNum(r.latitude),
    longitude: toNum(r.longitude),
    origin_address: r.origin_address || null,
    origin_latitude: toNum(r.origin_latitude),
    origin_longitude: toNum(r.origin_longitude),
    distance_m: Number(r.distance_m || 0),
    distance_label: formatDistance(Number(r.distance_m || 0)),
    item_count: Number(r.item_count || 0),
    /*
     * The order's weight, shown as INFORMATION.
     *
     * Nothing compares it to anything. It is on the card because it is how a
     * person decides whether to take a second pickup now or hold it — the
     * judgement stays with the rider, who is the one looking at the vehicle.
     */
    weight_kg: Number(r.total_weight_kg || 0),
    offered_at: r.offered_at,
    expires_in_seconds: Number(r.expires_in_seconds || 0),
  }));
}

/**
 * The rider's jobs.
 *
 * `scope` is 'active' (still to do) or 'completed' (today's finished work).
 * The contact number and handover code only travel for jobs the rider is
 * actually carrying — there is no reason a finished job should keep handing
 * out a customer's phone number.
 */
async function listJobs(riderId: string, scope: 'active' | 'completed' = 'active'): Promise<any[]> {
  const statusFilter =
    scope === 'active'
      ? `rj.status IN ('ASSIGNED','EN_ROUTE','ARRIVED')`
      : `rj.status = 'COMPLETED' AND DATE(rj.completed_at) = CURDATE()`;

  const result = await query<any>(
    `SELECT rj.*, o.order_number,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS total_quantity
       FROM rider_jobs rj
       JOIN orders o ON o.id = rj.order_id
      WHERE rj.rider_id = ? AND ${statusFilter}
      ORDER BY rj.assigned_at DESC`,
    [riderId]
  );

  return result.rows.map((r) => toJobPayload(r, scope === 'active'));
}

function toJobPayload(r: any, includeContact: boolean) {
  return {
    job_id: String(r.id),
    order_id: String(r.order_id),
    order_number: r.order_number,
    job_type: r.job_type,
    status: r.status,
    address_text: r.address_text,
    latitude: toNum(r.latitude),
    longitude: toNum(r.longitude),
    /*
     * Where the rider COLLECTS from, for a delivery: the facility. Null on a
     * pickup, which starts wherever the rider already is.
     */
    origin_address: r.origin_address || null,
    origin_latitude: toNum(r.origin_latitude),
    origin_longitude: toNum(r.origin_longitude),
    contact_name: r.contact_name,
    contact_mobile: includeContact ? r.contact_mobile : null,
    handover_code_required: Boolean(r.handover_code),
    weight_kg: Number(r.total_weight_kg || 0),
    item_count: Number(r.item_count || 0),
    total_quantity: Number(r.total_quantity || 0),
    assigned_at: r.assigned_at,
    en_route_at: r.en_route_at,
    arrived_at: r.arrived_at,
    collected_at: r.collected_at,
    completed_at: r.completed_at,
    rider_notes: r.rider_notes,
  };
}

/** One job in full, for the rider working it. */
async function getJobDetail(riderId: string, jobId: string): Promise<any> {
  const result = await query<any>(
    `SELECT rj.*, o.order_number,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS total_quantity
       FROM rider_jobs rj
       JOIN orders o ON o.id = rj.order_id
      WHERE rj.id = ? AND rj.rider_id = ?`,
    [jobId, riderId]
  );

  const row = result.rows[0];
  if (!row) throw new AppError('Job not found or not assigned to you', 404);

  const items = await query<any>(
    `SELECT service_name, quantity FROM order_items WHERE order_id = ? ORDER BY id ASC`,
    [row.order_id]
  );

  return {
    ...toJobPayload(row, true),
    // Pieces only. No unit price, no line amount, no order total.
    items: items.rows.map((i) => ({
      item_name: i.service_name,
      quantity: Number(i.quantity || 0),
    })),
  };
}

/**
 * Move a job along its own short pipeline.
 *
 *   ASSIGNED -> EN_ROUTE -> ARRIVED -> (completed via the handover code)
 *
 * Skipping a step is refused rather than tolerated: the timeline is what a
 * dispute is settled with, and one that can be written out of order settles
 * nothing.
 */
const JOB_TRANSITIONS: Record<string, string[]> = {
  HELD: ['ASSIGNED'],
  ASSIGNED: ['EN_ROUTE'],
  EN_ROUTE: ['ARRIVED'],
  // ARRIVED leaves only via the handover code, which is not a plain status
  // change -- see completeJob.
  ARRIVED: [],
  // A collected PICKUP is on the bike. It leaves via the facility drop.
  COLLECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};

async function updateJobStatus(riderId: string, jobId: string, target: string): Promise<any> {
  const allowed = ['EN_ROUTE', 'ARRIVED'];
  if (!allowed.includes(target)) {
    throw new AppError(`A rider can set: ${allowed.join(', ')}. Completing needs the code.`, 400);
  }

  const current = await query<any>(
    `SELECT id, status, order_id, job_type FROM rider_jobs WHERE id = ? AND rider_id = ?`,
    [jobId, riderId]
  );
  const job = current.rows[0];
  if (!job) throw new AppError('Job not found or not assigned to you', 404);

  const next = JOB_TRANSITIONS[job.status] || [];
  if (!next.includes(target)) {
    throw new AppError(
      `Cannot move a job from ${job.status} to ${target}.` +
        (next.length ? ` Next step: ${next.join(', ')}.` : ''),
      409
    );
  }

  const stamp = target === 'EN_ROUTE' ? 'en_route_at' : 'arrived_at';
  await query(`UPDATE rider_jobs SET status = ?, ${stamp} = NOW() WHERE id = ?`, [target, jobId]);

  const orderId = String(job.order_id);

  /*
   * PICKED_UP is NOT set here. Leaving for a door is not collecting from it,
   * and the order's own status must not claim otherwise until the handover
   * is confirmed below.
   */
  if (target === 'EN_ROUTE' && job.job_type === 'DELIVERY') {
    await query(`UPDATE orders SET status = 'OUT_FOR_DELIVERY' WHERE id = ?`, [orderId]);
    await query(
      `INSERT INTO order_status_history (order_id, status, changed_by, notes)
       VALUES (?, 'OUT_FOR_DELIVERY', ?, 'Rider is on the way')`,
      [orderId, riderId]
    );
    socketService.emitOrderStatusUpdate(orderId, { orderId, status: 'OUT_FOR_DELIVERY' });
  }

  if (target === 'ARRIVED') {
    await notifyOrderParty(
      orderId,
      'RIDER_ARRIVED',
      'Your rider has arrived',
      job.job_type === 'PICKUP'
        ? 'Your rider is at the pickup point. Please share your handover code.'
        : 'Your rider is at your door with your order. Please share your handover code.'
    );
  }

  socketService.emitJobUpdate(orderId, { jobId, status: target });
  logger.info(`[Rider] Job ${jobId} -> ${target} by rider ${riderId}`);

  return getJobDetail(riderId, jobId);
}

/**
 * Close the job with the code the other party reads out.
 *
 * This is the only way a job completes. A rider cannot mark work done on
 * their own say-so, which is what makes the record worth something when a
 * customer says a bag was never collected.
 *
 * The whole thing runs in one transaction: the job, the order's status, the
 * schedule row and the rider's counters all move together or not at all.
 */
async function completeJob(
  riderId: string,
  jobId: string,
  handoverCode: string,
  notes?: string
): Promise<any> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.execute(
      `SELECT id, status, order_id, job_type, handover_code
         FROM rider_jobs WHERE id = ? AND rider_id = ? FOR UPDATE`,
      [jobId, riderId]
    );
    const job = rows[0];
    if (!job) throw new AppError('Job not found or not assigned to you', 404);
    if (job.status === 'COMPLETED') throw new AppError('This job is already completed.', 409);
    if (job.status !== 'ARRIVED') {
      throw new AppError('Mark yourself as arrived before completing the handover.', 409);
    }

    const given = String(handoverCode || '').trim();
    if (!given) throw new AppError('The handover code is required.', 400);
    if (job.handover_code && given !== String(job.handover_code)) {
      throw new AppError('That code does not match. Please ask for it again.', 400);
    }

    const isPickup = job.job_type === 'PICKUP';

    /*
     * A COLLECTED PICKUP IS NOT A FINISHED PICKUP.
     *
     * The handover only means the bags are on the bike; the job is done when
     * they reach the facility. Marking it COMPLETED here — which is what this
     * did before — made the rider's load invisible the instant they picked it
     * up, so a rider carrying 105 kg looked empty to dispatch and was offered
     * the next pickup immediately. `dropAtFacility` closes it.
     *
     * A DELIVERY genuinely is finished at the handover: the goods are with
     * the customer and there is nothing left on the bike.
     */
    await connection.execute(
      isPickup
        ? `UPDATE rider_jobs SET status = 'COLLECTED', collected_at = NOW(), rider_notes = ?
            WHERE id = ?`
        : `UPDATE rider_jobs
              SET status = 'COMPLETED', collected_at = NOW(), completed_at = NOW(), rider_notes = ?
            WHERE id = ?`,
      [notes || null, jobId]
    );

    const orderId = String(job.order_id);
    const orderStatus = isPickup ? 'PICKED_UP' : 'DELIVERED';

    await connection.execute(`UPDATE orders SET status = ? WHERE id = ?`, [orderStatus, orderId]);
    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, changed_by, notes)
       VALUES (?, ?, ?, ?)`,
      [orderId, orderStatus, riderId, isPickup ? 'Collected by rider' : 'Delivered by rider']
    );

    // The customer's own schedule row records the same moment.
    if (isPickup) {
      await connection.execute(
        `UPDATE pickups SET status = 'COMPLETED', picked_up_at = NOW(), assigned_to = ?
          WHERE order_id = ?`,
        [riderId, orderId]
      );
    } else {
      await connection.execute(
        `UPDATE deliveries SET status = 'COMPLETED', delivered_at = NOW(), assigned_to = ?
          WHERE order_id = ?`,
        [riderId, orderId]
      );
    }

    /*
     * The counters move when the job ENDS. A collected pickup is still on the
     * rider's plate — it is carried, not finished — so only a delivery closes
     * out here; the pickup's counters move in `dropAtFacility`.
     */
    if (!isPickup) {
      await connection.execute(
        `UPDATE rider_profiles
            SET completed_jobs = completed_jobs + 1,
                active_job_count = GREATEST(active_job_count - 1, 0)
          WHERE user_id = ?`,
        [riderId]
      );
    }

    await connection.commit();

    socketService.emitOrderStatusUpdate(orderId, { orderId, status: orderStatus });
    socketService.emitJobUpdate(orderId, { jobId, status: 'COMPLETED' });

    await notifyOrderParty(
      orderId,
      isPickup ? 'PICKUP_COMPLETED' : 'DELIVERED',
      isPickup ? 'Order collected' : 'Order delivered',
      isPickup
        ? 'Your laundry has been collected and is on its way to us.'
        : 'Your order has been delivered. Thank you for using Swachham.'
    );

    logger.info(
      `[Rider] Job ${jobId} ${isPickup ? 'collected' : 'delivered'} by rider ${riderId} ` +
        `(${orderStatus})`
    );
    return getJobDetail(riderId, jobId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * The load reaches the facility. This is what ends a pickup.
 *
 * Separate from the handover on purpose: between the two the rider is
 * carrying the bags, and that window is exactly when capacity decides whether
 * they can take another job. Closing the job at the doorstep would erase the
 * load the moment it was acquired.
 *
 * Several collected pickups can be dropped in one go, which is what actually
 * happens — a rider does a round and empties the bike once.
 */
async function dropAtFacility(
  riderId: string,
  jobIds?: string[]
): Promise<{ dropped: number; still_carrying: number }> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const filter = jobIds && jobIds.length
      ? ` AND id IN (${jobIds.map(() => '?').join(',')})`
      : '';

    const [rows]: any = await connection.execute(
      `SELECT id, order_id FROM rider_jobs
        WHERE rider_id = ? AND job_type = 'PICKUP' AND status = 'COLLECTED'${filter}
        FOR UPDATE`,
      [riderId, ...(jobIds || [])]
    );

    if (rows.length === 0) {
      throw new AppError('You have nothing collected to drop off.', 409);
    }

    for (const row of rows) {
      await connection.execute(
        `UPDATE rider_jobs SET status = 'COMPLETED', completed_at = NOW() WHERE id = ?`,
        [row.id]
      );
      await connection.execute(
        `INSERT INTO order_status_history (order_id, status, changed_by, notes)
         VALUES (?, 'PICKED_UP', ?, 'Delivered to facility by rider')`,
        [row.order_id, riderId]
      );
    }

    await connection.execute(
      `UPDATE rider_profiles
          SET completed_jobs = completed_jobs + ?,
              active_job_count = GREATEST(active_job_count - ?, 0)
        WHERE user_id = ?`,
      [rows.length, rows.length, riderId]
    );

    await connection.commit();

    for (const row of rows) {
      socketService.emitJobUpdate(String(row.order_id), {
        jobId: String(row.id),
        status: 'COMPLETED',
      });
    }

    logger.info(`[Rider] Rider ${riderId} dropped ${rows.length} pickup(s) at the facility`);

    const left = await query<any>(
      `SELECT COUNT(*) AS n FROM rider_jobs
        WHERE rider_id = ? AND job_type = 'PICKUP' AND status = 'COLLECTED'`,
      [riderId]
    );
    return { dropped: rows.length, still_carrying: Number(left.rows[0]?.n || 0) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Jobs this rider has parked until they have room. */
async function listHeldJobs(riderId: string): Promise<any[]> {
  const result = await query<any>(
    `SELECT rj.*, o.order_number,
            TIMESTAMPDIFF(MINUTE, rj.held_at, NOW()) AS held_minutes,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS total_quantity
       FROM rider_jobs rj
       JOIN orders o ON o.id = rj.order_id
      WHERE rj.rider_id = ? AND rj.status = 'HELD'
      ORDER BY rj.held_at ASC`,
    [riderId]
  );

  return result.rows.map((r) => ({
    ...toJobPayload(r, true),
    held_minutes: Number(r.held_minutes || 0),
    /*
     * How long before the system takes it back. Shown so a rider knows the
     * hold is not indefinite, rather than finding out when the card vanishes.
     */
    reclaim_in_minutes: Math.max(0, HOLD_MAX_MINUTES - Number(r.held_minutes || 0)),
  }));
}

/**
 * Take a held job on now.
 *
 * The rider has unloaded and come back for it. It becomes an ordinary
 * assigned job from here, so nothing downstream needs to know it was held.
 */
async function startHeldJob(riderId: string, jobId: string): Promise<any> {
  const updated = await query(
    `UPDATE rider_jobs
        SET status = 'ASSIGNED', assigned_at = NOW(), held_at = NULL
      WHERE id = ? AND rider_id = ? AND status = 'HELD'`,
    [jobId, riderId]
  );

  if (!updated.rowCount) {
    throw new AppError('That job is not on hold for you any more.', 409);
  }

  await query(
    `UPDATE rider_profiles SET active_job_count = active_job_count + 1 WHERE user_id = ?`,
    [riderId]
  );

  const job = await query<any>(`SELECT order_id FROM rider_jobs WHERE id = ?`, [jobId]);
  const orderId = String(job.rows[0].order_id);
  await query(`UPDATE orders SET status = 'PICKUP_ASSIGNED' WHERE id = ?`, [orderId]);
  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by, notes)
     VALUES (?, 'PICKUP_ASSIGNED', ?, 'Rider started a held job')`,
    [orderId, riderId]
  );

  socketService.emitOrderStatusUpdate(orderId, { orderId, status: 'PICKUP_ASSIGNED' });
  logger.info(`[Rider] Rider ${riderId} started held job ${jobId}`);
  return getJobDetail(riderId, jobId);
}

/** Give a held job back to the pool before the reclaim timer does it. */
async function releaseHeldJob(riderId: string, jobId: string): Promise<void> {
  const updated = await query(
    `UPDATE rider_jobs
        SET status = 'PENDING', rider_id = NULL, held_at = NULL
      WHERE id = ? AND rider_id = ? AND status = 'HELD'`,
    [jobId, riderId]
  );

  if (!updated.rowCount) {
    throw new AppError('That job is not on hold for you.', 404);
  }

  // The holder steps out of the running so the next round looks elsewhere.
  await query(
    `UPDATE rider_job_offers SET status = 'DECLINED' WHERE job_id = ? AND rider_id = ?`,
    [jobId, riderId]
  );

  logger.info(`[Rider] Rider ${riderId} released held job ${jobId}`);
  await dispatchJob(jobId);
}

/**
 * The rider gives a job back.
 *
 * The job returns to the pool and is fanned out again rather than being
 * quietly dropped — a bike with a puncture must not strand an order.
 */
async function releaseJob(riderId: string, jobId: string, reason?: string): Promise<void> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.execute(
      `SELECT id, status, order_id FROM rider_jobs WHERE id = ? AND rider_id = ? FOR UPDATE`,
      [jobId, riderId]
    );
    const job = rows[0];
    if (!job) throw new AppError('Job not found or not assigned to you', 404);
    if (!ACTIVE_STATUSES.includes(job.status)) {
      throw new AppError(`A ${job.status} job cannot be given back.`, 409);
    }

    await connection.execute(
      `UPDATE rider_jobs
          SET status = 'PENDING', rider_id = NULL, assigned_at = NULL,
              en_route_at = NULL, arrived_at = NULL, rider_notes = ?
        WHERE id = ?`,
      [reason || null, jobId]
    );

    // The rider who gave it back is not offered it again on the next round.
    await connection.execute(
      `UPDATE rider_job_offers SET status = 'DECLINED', responded_at = NOW()
        WHERE job_id = ? AND rider_id = ?`,
      [jobId, riderId]
    );

    await connection.execute(
      `UPDATE rider_profiles SET active_job_count = GREATEST(active_job_count - 1, 0)
        WHERE user_id = ?`,
      [riderId]
    );

    await connection.commit();
    logger.info(`[Rider] Rider ${riderId} released job ${jobId}: ${reason || 'no reason given'}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // Re-offer outside the transaction: dispatch writes its own rows.
  await dispatchJob(jobId);
}

/**
 * The rider's own day, and their running totals.
 *
 * Counts and distance only. What the orders were worth is not a rider
 * question, so no amount appears here.
 */
async function getSummary(riderId: string): Promise<any> {
  const profile = await getOrCreateProfile(riderId);

  const today = await query<any>(
    `SELECT
       SUM(job_type = 'PICKUP')   AS pickups,
       SUM(job_type = 'DELIVERY') AS deliveries,
       COUNT(*)                   AS total
     FROM rider_jobs
     WHERE rider_id = ? AND status = 'COMPLETED' AND DATE(completed_at) = CURDATE()`,
    [riderId]
  );

  const pending = await query<any>(
    `SELECT COUNT(*) AS n FROM rider_jobs
      WHERE rider_id = ? AND status IN ('ASSIGNED','EN_ROUTE','ARRIVED')`,
    [riderId]
  );

  const openOffers = await query<any>(
    `SELECT COUNT(*) AS n FROM rider_job_offers rjo
       JOIN rider_jobs rj ON rj.id = rjo.job_id
      WHERE rjo.rider_id = ? AND rjo.status = 'OFFERED' AND rj.status = 'OFFERED'`,
    [riderId]
  );

  const held = await query<any>(
    `SELECT COUNT(*) AS n FROM rider_jobs WHERE rider_id = ? AND status = 'HELD'`,
    [riderId]
  );

  // Pickups collected and not yet dropped at the facility.
  const carrying = await query<any>(
    `SELECT COUNT(*) AS n FROM rider_jobs
      WHERE rider_id = ? AND job_type = 'PICKUP' AND status = 'COLLECTED'`,
    [riderId]
  );

  const row = today.rows[0] || {};
  return {
    profile,
    today: {
      pickups: Number(row.pickups || 0),
      deliveries: Number(row.deliveries || 0),
      completed: Number(row.total || 0),
    },
    active_jobs: Number(pending.rows[0]?.n || 0),
    open_offers: Number(openOffers.rows[0]?.n || 0),
    held_jobs: Number(held.rows[0]?.n || 0),
    /** Collected pickups still to be dropped at the facility. */
    carrying_jobs: Number(carrying.rows[0]?.n || 0),
    lifetime: {
      completed: profile.completed_jobs,
      cancelled: profile.cancelled_jobs,
    },
  };
}

/**
 * Notify whoever placed the order — customer or business contact.
 *
 * A business order hangs off `business_user_id`, and `business_users` is not
 * `users`, so a notification row (whose FK points at `users`) can only be
 * written for a customer order. The business case is delivered over the
 * socket only, rather than being dropped or crashing on a foreign key.
 */
async function notifyOrderParty(
  orderId: string,
  type: string,
  title: string,
  body: string
): Promise<void> {
  try {
    const result = await query<any>(
      `SELECT user_id, business_user_id FROM orders WHERE id = ?`,
      [orderId]
    );
    const row = result.rows[0];
    if (!row) return;

    if (row.user_id) {
      await createNotification(String(row.user_id), orderId, type, title, body, { orderId });
    } else {
      socketService.emitJobUpdate(orderId, { orderId, type, title, body });
    }
  } catch (error) {
    logger.error(
      `[Rider] Could not notify the party on order ${orderId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export {
  getOrCreateProfile,
  updateProfile,
  setOnlineStatus,
  updateLocation,
  listOffers,
  listJobs,
  getJobDetail,
  updateJobStatus,
  completeJob,
  dropAtFacility,
  listHeldJobs,
  startHeldJob,
  releaseHeldJob,
  releaseJob,
  getSummary,
  STALE_FIX_MINUTES,
};
