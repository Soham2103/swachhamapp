import { getClient, query } from '../config/database';
import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import socketService from './socket.service';
import { createNotification } from './notification.service';

/**
 * ===================================================================
 * DISPATCH — matching physical work to the rider nearest it
 * ===================================================================
 *
 * The rule the business asked for, in order:
 *
 *   1. An order is placed. Riders near the pickup point get an ADVISORY
 *      — "work is coming your way" — and nothing more. No job exists yet
 *      and none can be accepted, because the order has not been
 *      confirmed by anyone.
 *
 *   2. The SORTER accepts the order. That is the confirmation, and only
 *      then is a real pickup job created.
 *
 *   3. The job is OFFERED to the nearest online riders at once. The
 *      first to accept takes it; every other offer is superseded and
 *      the card clears from their phones.
 *
 * Offering to several riders rather than assigning to the single
 * closest one is deliberate. The closest rider may be looking at their
 * handlebars, and an order that waits for one person to notice is an
 * order that waits. Fan-out with first-accept-wins is what keeps the
 * pickup moving without a human dispatcher.
 */

/**
 * How far from the pickup point a rider can be and still be offered it.
 *
 * Configurable because the right answer is not a constant: a dense town and a
 * district where the next rider is two villages away want very different
 * numbers, and testing from a different city wants a bigger one still.
 */
const OFFER_RADIUS_M = Number(process.env.RIDER_OFFER_RADIUS_M || 7000);

/**
 * How many riders one job is offered to at a time.
 *
 * Small on purpose. Offering to everyone would turn every order into a
 * race that most riders lose, which trains them to stop looking.
 */
const MAX_CANDIDATES = 5;

/**
 * How long a rider has to answer before the offer lapses.
 *
 * Configurable for the same reason the radius is. Ninety seconds is right for
 * a rider watching the app, and far too short for a person testing the flow
 * who has to sign out of one account and into another in between.
 */
const OFFER_TTL_SECONDS = Number(process.env.RIDER_OFFER_TTL_SECONDS || 90);

/**
 * A fix older than this does not count as a position.
 *
 * A rider who closed the app three hours ago may still read as ONLINE if
 * their phone never delivered the offline call. Dispatching to their last
 * known street corner would send the order somewhere nobody is.
 *
 * Configurable because a tester signed in as somebody else is not pinging:
 * their rider position ages while they work through another role, and a
 * fifteen-minute window makes them vanish mid-scenario.
 */
const STALE_FIX_MINUTES = Number(process.env.RIDER_STALE_FIX_MINUTES || 15);

/** Give up fanning out after this many rounds and ask for a human. */
const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * How long a rider may sit on a HELD job before it is taken back.
 *
 * Holding is for "I am full, I will take it once I have unloaded" — a round
 * trip to the facility, not a shift. Without a ceiling a full rider could
 * park an order indefinitely and nobody else would ever be offered it, which
 * is the one way this feature could make service worse instead of better.
 */
const HOLD_MAX_MINUTES = 45;

export type JobType = 'PICKUP' | 'DELIVERY';

export interface RiderJob {
  id: string;
  order_id: string;
  order_number: string;
  job_type: JobType;
  status: string;
  rider_id: string | null;
  latitude: number | null;
  longitude: number | null;
  address_text: string | null;
  contact_name: string | null;
  contact_mobile: string | null;
  handover_code: string | null;
  /**
   * Where the rider COLLECTS from, when that is not simply "wherever they
   * are". Set for a DELIVERY (the facility) and null for a PICKUP.
   */
  origin_latitude: number | null;
  origin_longitude: number | null;
  origin_address: string | null;
  /**
   * The order's weight, read from `orders.total_weight_kg`.
   *
   * Shown to the rider as INFORMATION — it is how a person decides whether
   * they can take another pickup right now. Nothing computes with it and no
   * rule is enforced on it; there is no capacity field anywhere.
   */
  weight_kg: number;
  created_at: Date;
}

/**
 * Where an order is to be collected from, and who to ask for.
 *
 * An order is either a customer's (address_id -> customer_addresses) or an
 * establishment's (business_user_id -> businesses). Both carry their own
 * latitude and longitude, so the two cases resolve to the same shape and
 * everything downstream stops caring which kind of order it is.
 */
async function resolvePickupPoint(orderId: string): Promise<{
  latitude: number | null;
  longitude: number | null;
  address_text: string | null;
  contact_name: string | null;
  contact_mobile: string | null;
  order_number: string;
}> {
  const result = await query<any>(
    `SELECT o.order_number,
            o.placed_by_mobile,
            ca.latitude        AS cust_lat,
            ca.longitude       AS cust_lng,
            ca.full_address    AS cust_address,
            u.name             AS cust_name,
            u.mobile_number    AS cust_mobile,
            b.latitude         AS biz_lat,
            b.longitude        AS biz_lng,
            COALESCE(b.establishment_address, b.address) AS biz_address,
            COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS biz_name,
            bu.mobile_number   AS biz_mobile
       FROM orders o
       LEFT JOIN customer_addresses ca ON ca.id = o.address_id
       LEFT JOIN users u              ON u.id = o.user_id
       LEFT JOIN business_users bu    ON bu.id = o.business_user_id
       LEFT JOIN businesses b         ON b.id = bu.business_id
      WHERE o.id = ?`,
    [orderId]
  );

  const row = result.rows[0];
  if (!row) throw new AppError('Order not found', 404);

  const isBusiness = row.biz_lat !== null || row.biz_name !== null;

  return {
    order_number: row.order_number,
    latitude: toNum(isBusiness ? row.biz_lat : row.cust_lat),
    longitude: toNum(isBusiness ? row.biz_lng : row.cust_lng),
    address_text: (isBusiness ? row.biz_address : row.cust_address) || null,
    contact_name: (isBusiness ? row.biz_name : row.cust_name) || null,
    // The number the order was actually placed from wins: for a business it
    // is whichever contact signed in, which is who the rider should call.
    contact_mobile: row.placed_by_mobile || (isBusiness ? row.biz_mobile : row.cust_mobile) || null,
  };
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The processing facility, from configuration.
 *
 * Snapshotted onto every delivery job at creation, like the customer address
 * is, so moving the facility does not rewrite journeys already made.
 */
function facilityPoint() {
  return {
    latitude: Number.isFinite(config.FACILITY_LATITUDE) ? config.FACILITY_LATITUDE : null,
    longitude: Number.isFinite(config.FACILITY_LONGITUDE) ? config.FACILITY_LONGITUDE : null,
    address: config.FACILITY_ADDRESS || config.FACILITY_NAME,
  };
}

/**
 * THE POINT A JOB IS MATCHED ON — which is not always its destination.
 *
 * A PICKUP is matched on the customer's door: the rider starts from wherever
 * they are and that door is the only place involved.
 *
 * A DELIVERY is matched on the FACILITY. The rider has to load the finished
 * laundry before they can deliver it, so the facility is their first stop.
 * Matching on the customer instead would offer the job to whoever happens to
 * live near a door they cannot usefully visit until they have driven across
 * the district to collect — which is how an order ends up with the rider
 * furthest from the work.
 */
function matchPointFor(job: {
  job_type: JobType;
  latitude: number | null;
  longitude: number | null;
  origin_latitude: number | null;
  origin_longitude: number | null;
}): { latitude: number | null; longitude: number | null } {
  if (job.job_type === 'DELIVERY' && job.origin_latitude !== null) {
    return { latitude: job.origin_latitude, longitude: job.origin_longitude };
  }
  return { latitude: job.latitude, longitude: job.longitude };
}

/** Four digits the other party reads out to close the handover. */
function generateHandoverCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * The SQL distance expression, in metres.
 *
 * The equirectangular approximation, not the full haversine: over the few
 * kilometres a rider could plausibly cover it agrees with haversine to well
 * under a metre, and it is a good deal cheaper to evaluate per row. 111320 is
 * metres per degree of latitude; longitude degrees are shortened by the
 * cosine of the latitude.
 */
const DISTANCE_SQL = `
  ROUND(
    SQRT(
      POW((rp.last_latitude - ?) * 111320, 2) +
      POW((rp.last_longitude - ?) * 111320 * COS(RADIANS(?)), 2)
    )
  )`;

/**
 * Online riders near a point, nearest first.
 *
 * The bounding-box predicate is not decoration: it lets MySQL use the
 * location index to discard most riders before any arithmetic runs, which is
 * the difference between an index range scan and computing a distance for
 * every rider on the books.
 */
async function findNearbyRiders(
  latitude: number,
  longitude: number,
  radiusM: number,
  limit: number,
  excludeRiderIds: string[] = []
): Promise<Array<{ user_id: string; name: string | null; distance_m: number }>> {
  const latPad = radiusM / 111320;
  const lngPad = radiusM / (111320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));

  const exclusion = excludeRiderIds.length
    ? ` AND rp.user_id NOT IN (${excludeRiderIds.map(() => '?').join(',')})`
    : '';

  /*
   * Bound in statement order, which is what mysql2 expects:
   *   3  the distance expression (lat, lng, lat)
   *   4  the bounding box
   *   1  the stale-fix cutoff
   *   n  the excluded rider ids
   *   1  the radius, compared against the distance ALIAS in HAVING
   *
   * HAVING re-uses the alias rather than repeating the expression, so the
   * three distance parameters appear exactly once.
   */
  const params: any[] = [
    latitude,
    longitude,
    latitude,
    latitude - latPad,
    latitude + latPad,
    longitude - lngPad,
    longitude + lngPad,
    STALE_FIX_MINUTES,
    ...excludeRiderIds,
    radiusM,
  ];

  const result = await query<any>(
    `SELECT rp.user_id, u.name, ${DISTANCE_SQL} AS distance_m
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.is_online = TRUE
        AND u.is_active = TRUE
        AND rp.active_job_count < rp.max_active_jobs
        AND rp.last_latitude IS NOT NULL
        AND rp.last_longitude IS NOT NULL
        AND rp.last_latitude BETWEEN ? AND ?
        AND rp.last_longitude BETWEEN ? AND ?
        AND rp.last_location_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ${exclusion}
     HAVING distance_m <= ?
      ORDER BY distance_m ASC
      LIMIT ${Math.max(1, Math.min(Number(limit) || MAX_CANDIDATES, 20))}`,
    params
  );

  return result.rows.map((r) => ({
    user_id: String(r.user_id),
    name: r.name || null,
    distance_m: Number(r.distance_m || 0),
  }));
}

/**
 * STEP 1 — the advisory, fired when an order is placed.
 *
 * Tells nearby riders that work is coming without creating anything they can
 * act on. Nothing here can fail the order: it is called after the order's own
 * transaction has committed, and every error is swallowed.
 */
async function notifyNearbyRidersOfNewOrder(orderId: string): Promise<number> {
  try {
    const point = await resolvePickupPoint(orderId);
    if (point.latitude === null || point.longitude === null) {
      logger.info(
        `[Dispatch] Order ${point.order_number} has no coordinates; skipping rider advisory`
      );
      return 0;
    }

    const riders = await findNearbyRiders(
      point.latitude,
      point.longitude,
      OFFER_RADIUS_M,
      MAX_CANDIDATES
    );

    for (const rider of riders) {
      await createNotification(
        rider.user_id,
        orderId,
        'RIDER_NEARBY_ORDER',
        'New order nearby',
        `An order was just placed about ${formatDistance(rider.distance_m)} away. ` +
          `You will be offered the pickup once it is confirmed.`,
        { orderId, distanceM: rider.distance_m, advisory: true }
      );
      socketService.emitRiderAdvisory(rider.user_id, {
        orderId,
        orderNumber: point.order_number,
        distanceM: rider.distance_m,
      });
    }

    logger.info(
      `[Dispatch] Advisory for order ${point.order_number} sent to ${riders.length} rider(s)`
    );
    return riders.length;
  } catch (error) {
    logger.error(
      `[Dispatch] Advisory failed for order ${orderId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return 0;
  }
}

/**
 * STEP 2 — the sorter confirmed the order, so the pickup becomes real.
 *
 * Creating the job and dispatching it are separate calls so a job can exist
 * unassigned (nobody online) and be fanned out again later without being
 * created twice. The UNIQUE(order_id, job_type) key means a repeated
 * acceptance cannot produce a second pickup.
 */
async function createJobForOrder(orderId: string, jobType: JobType): Promise<RiderJob | null> {
  const point = await resolvePickupPoint(orderId);

  const existing = await query<any>(
    `SELECT id FROM rider_jobs WHERE order_id = ? AND job_type = ?`,
    [orderId, jobType]
  );
  if (existing.rows.length > 0) {
    logger.info(`[Dispatch] ${jobType} job already exists for order ${point.order_number}`);
    return getJobById(String(existing.rows[0].id));
  }

  // A delivery starts at the facility; a pickup starts wherever the rider is.
  const origin = jobType === 'DELIVERY' ? facilityPoint() : null;

  const inserted = await query(
    `INSERT INTO rider_jobs
       (order_id, job_type, status, latitude, longitude,
        origin_latitude, origin_longitude, origin_address,
        address_text, contact_name, contact_mobile, handover_code)
     VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      jobType,
      point.latitude,
      point.longitude,
      origin ? origin.latitude : null,
      origin ? origin.longitude : null,
      origin ? origin.address : null,
      point.address_text,
      point.contact_name,
      point.contact_mobile,
      generateHandoverCode(),
    ]
  );

  if (!inserted.insertId) return null;

  // Point the customer's schedule row at the job that will fulfil it.
  const scheduleTable = jobType === 'PICKUP' ? 'pickups' : 'deliveries';
  await query(`UPDATE ${scheduleTable} SET rider_job_id = ? WHERE order_id = ?`, [
    inserted.insertId,
    orderId,
  ]);

  logger.info(
    `[Dispatch] ${jobType} job ${inserted.insertId} created for order ${point.order_number}`
  );
  return getJobById(String(inserted.insertId));
}

/**
 * STEP 3 — offer the job to the nearest riders.
 *
 * Returns how many riders were reached. Zero means nobody was in range and
 * the job is left UNASSIGNED for a human to place.
 */
async function dispatchJob(jobId: string): Promise<{ offered: number; job: RiderJob | null }> {
  const job = await getJobById(jobId);
  if (!job) throw new AppError('Job not found', 404);

  if (job.status !== 'PENDING' && job.status !== 'OFFERED' && job.status !== 'UNASSIGNED') {
    logger.info(`[Dispatch] Job ${jobId} is ${job.status}; not dispatching`);
    return { offered: 0, job };
  }

  // A delivery is matched on the facility, a pickup on the customer's door.
  const match = matchPointFor(job);

  if (match.latitude === null || match.longitude === null) {
    logger.warn(`[Dispatch] Job ${jobId} has no coordinates; cannot match a rider`);
    await query(`UPDATE rider_jobs SET status = 'UNASSIGNED' WHERE id = ?`, [jobId]);
    return { offered: 0, job };
  }

  // Riders who already turned this job down are not asked twice.
  const declined = await query<any>(
    `SELECT rider_id FROM rider_job_offers
      WHERE job_id = ? AND status IN ('DECLINED','EXPIRED')`,
    [jobId]
  );
  const skip = declined.rows.map((r) => String(r.rider_id));

  const riders = await findNearbyRiders(
    match.latitude,
    match.longitude,
    OFFER_RADIUS_M,
    MAX_CANDIDATES,
    skip
  );

  if (riders.length === 0) {
    await query(
      `UPDATE rider_jobs
          SET status = 'UNASSIGNED', dispatch_attempts = dispatch_attempts + 1
        WHERE id = ?`,
      [jobId]
    );
    logger.warn(`[Dispatch] No rider available for job ${jobId} (order ${job.order_number})`);
    return { offered: 0, job: await getJobById(jobId) };
  }

  /*
   * THE EXPIRY IS COMPUTED BY THE DATABASE, not by this process.
   *
   * It used to be `new Date(Date.now() + TTL)` handed to mysql2, which
   * serialises a JS Date using the NODE PROCESS's timezone. The database
   * runs in UTC and this machine in IST, so a 90-second offer was stored
   * with an expiry 5.5 hours out (90 + 19800 seconds, measured) and no
   * offer ever lapsed: stale cards sat on riders' phones for hours and
   * `expireStaleOffers` had nothing to sweep.
   *
   * DATE_ADD(NOW(), ...) keeps both timestamps on the same clock, so the
   * TTL is correct whatever timezone the server happens to run in.
   */
  for (const rider of riders) {
    /*
     * ON DUPLICATE KEY re-arms an existing row rather than inserting a
     * second. A rider whose earlier offer expired can be asked again on a
     * later round, and the unique key keeps that to one row per rider per job.
     */
    await query(
      `INSERT INTO rider_job_offers (job_id, rider_id, status, distance_m, offered_at, expires_at)
       VALUES (?, ?, 'OFFERED', ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE
         status = 'OFFERED', distance_m = VALUES(distance_m),
         offered_at = NOW(), expires_at = VALUES(expires_at), responded_at = NULL`,
      [jobId, rider.user_id, rider.distance_m, OFFER_TTL_SECONDS]
    );

    await createNotification(
      rider.user_id,
      job.order_id,
      'RIDER_JOB_OFFER',
      job.job_type === 'PICKUP' ? 'New pickup nearby' : 'New delivery nearby',
      `${
        job.job_type === 'DELIVERY'
          ? `Collect from ${job.origin_address || 'the facility'}`
          : job.address_text || 'Address on the job'
      } — ${formatDistance(rider.distance_m)} away.`,
      {
        jobId,
        orderId: job.order_id,
        distanceM: rider.distance_m,
        jobType: job.job_type,
      }
    );

    socketService.emitJobOffer(rider.user_id, {
      jobId,
      orderId: job.order_id,
      orderNumber: job.order_number,
      jobType: job.job_type,
      addressText: job.address_text,
      originAddress: job.origin_address,
      weightKg: job.weight_kg,
      distanceM: rider.distance_m,
      // A real instant for the client's countdown. Unlike the stored column
      // this never round-trips through MySQL, so no timezone is involved.
      expiresInSeconds: OFFER_TTL_SECONDS,
    });
  }

  await query(
    `UPDATE rider_jobs
        SET status = 'OFFERED', dispatched_at = NOW(), dispatch_attempts = dispatch_attempts + 1
      WHERE id = ?`,
    [jobId]
  );

  logger.info(
    `[Dispatch] Job ${jobId} (order ${job.order_number}) offered to ${riders.length} rider(s)`
  );
  return { offered: riders.length, job: await getJobById(jobId) };
}

/**
 * A rider takes the job. FIRST ONE WINS.
 *
 * The claim is a single conditional UPDATE inside a transaction: the row is
 * locked, and `status = 'OFFERED' AND rider_id IS NULL` is what makes it
 * atomic. Two riders tapping Accept in the same instant both run this; one
 * update matches a row and one matches nothing, and the one that matched
 * nothing is told the job is gone. Checking first and then writing would let
 * both pass the check.
 */
async function acceptJob(jobId: string, riderId: string): Promise<RiderJob> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    /*
     * `has_expired` is decided by MySQL, not by comparing a JS Date.
     *
     * Reading a DATETIME back through mysql2 reinterprets it in the process
     * timezone, which is the mirror image of the write bug above: the value
     * comes back 5.5 hours adrift on this machine. Asking the database
     * whether its own timestamp has passed sidesteps the conversion.
     */
    const [offerRows]: any = await connection.execute(
      `SELECT id, status, (expires_at < NOW()) AS has_expired
         FROM rider_job_offers
        WHERE job_id = ? AND rider_id = ? FOR UPDATE`,
      [jobId, riderId]
    );
    const offer = offerRows[0];
    if (!offer) {
      throw new AppError('This job was not offered to you.', 403);
    }
    if (offer.status === 'SUPERSEDED') {
      throw new AppError('Another rider has already taken this job.', 409);
    }
    /*
     * `has_expired` is compared as a NUMBER, not tested for truthiness.
     *
     * The pool runs with `bigNumberStrings: true`, so MySQL returns this
     * comparison as the STRING '0' or '1' — and '0' is truthy in JavaScript.
     * Writing `if (offer.has_expired)` therefore rejected every offer as
     * expired, including one issued a second earlier.
     */
    if (offer.status === 'EXPIRED' || Number(offer.has_expired) === 1) {
      throw new AppError('This offer has expired.', 410);
    }

    const [claimed]: any = await connection.execute(
      `UPDATE rider_jobs
          SET status = 'ASSIGNED', rider_id = ?, assigned_at = NOW()
        WHERE id = ? AND status = 'OFFERED' AND rider_id IS NULL`,
      [riderId, jobId]
    );

    if (claimed.affectedRows === 0) {
      throw new AppError('Another rider has already taken this job.', 409);
    }

    await connection.execute(
      `UPDATE rider_job_offers SET status = 'ACCEPTED', responded_at = NOW()
        WHERE job_id = ? AND rider_id = ?`,
      [jobId, riderId]
    );

    // Everyone else's card is now stale.
    await connection.execute(
      `UPDATE rider_job_offers SET status = 'SUPERSEDED', responded_at = NOW()
        WHERE job_id = ? AND rider_id <> ? AND status = 'OFFERED'`,
      [jobId, riderId]
    );

    await connection.execute(
      `UPDATE rider_profiles SET active_job_count = active_job_count + 1 WHERE user_id = ?`,
      [riderId]
    );

    // The order moves to the matching assigned status.
    const [jobRows]: any = await connection.execute(
      `SELECT order_id, job_type FROM rider_jobs WHERE id = ?`,
      [jobId]
    );
    const orderId = String(jobRows[0].order_id);
    const orderStatus = jobRows[0].job_type === 'PICKUP' ? 'PICKUP_ASSIGNED' : 'DELIVERY_ASSIGNED';

    await connection.execute(`UPDATE orders SET status = ? WHERE id = ?`, [orderStatus, orderId]);
    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, changed_by, notes)
       VALUES (?, ?, ?, 'Rider accepted the job')`,
      [orderId, orderStatus, riderId]
    );

    await connection.commit();

    socketService.emitJobTaken(jobId, { takenBy: riderId });
    socketService.emitOrderStatusUpdate(orderId, { orderId, status: orderStatus });
    socketService.emitJobUpdate(orderId, { jobId, status: 'ASSIGNED' });

    logger.info(`[Dispatch] Job ${jobId} accepted by rider ${riderId}`);

    const job = await getJobById(jobId);
    if (!job) throw new AppError('Job not found after accept', 500);
    return job;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** The rider passes. The job is re-offered to whoever is next nearest. */
async function declineJob(jobId: string, riderId: string): Promise<void> {
  const updated = await query(
    `UPDATE rider_job_offers SET status = 'DECLINED', responded_at = NOW()
      WHERE job_id = ? AND rider_id = ? AND status = 'OFFERED'`,
    [jobId, riderId]
  );

  if (!updated.rowCount) {
    throw new AppError('No open offer for this job.', 404);
  }

  logger.info(`[Dispatch] Rider ${riderId} declined job ${jobId}`);

  // Nobody left holding it? Widen the net, up to the retry ceiling.
  const remaining = await query<any>(
    `SELECT COUNT(*) AS n FROM rider_job_offers WHERE job_id = ? AND status = 'OFFERED'`,
    [jobId]
  );
  if (Number(remaining.rows[0]?.n || 0) === 0) {
    const job = await getJobById(jobId);
    const attempts = await query<any>(
      `SELECT dispatch_attempts FROM rider_jobs WHERE id = ?`,
      [jobId]
    );
    if (job && Number(attempts.rows[0]?.dispatch_attempts || 0) < MAX_DISPATCH_ATTEMPTS) {
      await dispatchJob(jobId);
    } else {
      await query(`UPDATE rider_jobs SET status = 'UNASSIGNED' WHERE id = ?`, [jobId]);
    }
  }
}

/**
 * The rider claims the job but defers it: "I am full right now."
 *
 * This is the third answer to an offer, and it exists because the second one
 * was wrong for a loaded rider. Accept and Decline force a choice between
 * taking work you cannot physically carry and giving up work you want — so a
 * rider with a full bike had to decline, and the order went to someone
 * further away while the nearest rider was ten minutes from unloading.
 *
 * A held job is RESERVED: it is not offered to anyone else, so the rider can
 * finish their current run and come back to it. It is reclaimed automatically
 * after HOLD_MAX_MINUTES so the order cannot be lost behind a bike that never
 * empties.
 */
async function holdJob(jobId: string, riderId: string): Promise<RiderJob> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [offerRows]: any = await connection.execute(
      `SELECT id, status, (expires_at < NOW()) AS has_expired
         FROM rider_job_offers
        WHERE job_id = ? AND rider_id = ? FOR UPDATE`,
      [jobId, riderId]
    );
    const offer = offerRows[0];
    if (!offer) throw new AppError('This job was not offered to you.', 403);
    if (offer.status === 'SUPERSEDED') {
      throw new AppError('Another rider has already taken this job.', 409);
    }
    // Same string-vs-number trap as the accept path above.
    if (offer.status === 'EXPIRED' || Number(offer.has_expired) === 1) {
      throw new AppError('This offer has expired.', 410);
    }

    /*
     * The same conditional UPDATE the accept path uses, for the same reason:
     * holding also takes the job out of the pool, so it has to be atomic
     * against another rider accepting it in the same instant.
     */
    const [claimed]: any = await connection.execute(
      `UPDATE rider_jobs
          SET status = 'HELD', held_at = NOW(), held_by = ?, rider_id = ?
        WHERE id = ? AND status = 'OFFERED' AND rider_id IS NULL`,
      [riderId, riderId, jobId]
    );
    if (claimed.affectedRows === 0) {
      throw new AppError('Another rider has already taken this job.', 409);
    }

    await connection.execute(
      `UPDATE rider_job_offers SET status = 'HELD', responded_at = NOW()
        WHERE job_id = ? AND rider_id = ?`,
      [jobId, riderId]
    );
    await connection.execute(
      `UPDATE rider_job_offers SET status = 'SUPERSEDED', responded_at = NOW()
        WHERE job_id = ? AND rider_id <> ? AND status = 'OFFERED'`,
      [jobId, riderId]
    );

    await connection.commit();
    socketService.emitJobTaken(jobId, { heldBy: riderId });
    logger.info(`[Dispatch] Job ${jobId} put on hold by rider ${riderId}`);

    const job = await getJobById(jobId);
    if (!job) throw new AppError('Job not found after hold', 500);
    return job;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Takes back jobs that have been held too long and re-offers them.
 *
 * `held_by` is deliberately kept when `rider_id` is cleared: the reclaimed
 * job is dispatched again, and the rider who could not carry it should not be
 * first in the queue to be asked a second time.
 */
async function reclaimStaleHolds(): Promise<number> {
  const stale = await query<any>(
    `SELECT id FROM rider_jobs
      WHERE status = 'HELD'
        AND held_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [HOLD_MAX_MINUTES]
  );

  for (const row of stale.rows) {
    await query(
      `UPDATE rider_jobs
          SET status = 'PENDING', rider_id = NULL, held_at = NULL
        WHERE id = ? AND status = 'HELD'`,
      [String(row.id)]
    );
    // The holder declines by default, so the next round looks elsewhere first.
    await query(
      `UPDATE rider_job_offers SET status = 'DECLINED'
        WHERE job_id = ? AND status = 'HELD'`,
      [String(row.id)]
    );
    logger.warn(`[Dispatch] Job ${row.id} held too long; reclaimed and re-offered`);
    await dispatchJob(String(row.id));
  }

  return stale.rows.length;
}

/**
 * Re-offers jobs whose offers have ALL lapsed.
 *
 * A real gap, not a testing convenience. `dispatchJob` leaves a job at
 * OFFERED, and `expireStaleOffers` marks the individual offers EXPIRED when
 * nobody answers — but nothing then put the job back in front of anyone. It
 * sat at OFFERED with no live offer against it: invisible to every rider's
 * list, and untouched by the decline path that normally triggers a re-offer.
 * An order whose riders simply did not look at their phones was silently
 * stranded.
 *
 * Bounded by MAX_DISPATCH_ATTEMPTS, so a job nobody ever takes ends up
 * UNASSIGNED for a human rather than cycling for ever.
 */
async function redispatchStaleJobs(): Promise<number> {
  const stranded = await query<any>(
    `SELECT rj.id
       FROM rider_jobs rj
      WHERE rj.status = 'OFFERED'
        AND rj.dispatch_attempts < ?
        AND NOT EXISTS (
              SELECT 1 FROM rider_job_offers o
               WHERE o.job_id = rj.id AND o.status = 'OFFERED' AND o.expires_at > NOW()
            )`,
    [MAX_DISPATCH_ATTEMPTS]
  );

  for (const row of stranded.rows) {
    logger.info(`[Dispatch] Job ${row.id} had no live offers left; re-offering`);
    await dispatchJob(String(row.id));
  }

  return stranded.rows.length;
}

/**
 * Lapse offers nobody answered.
 *
 * Called opportunistically when a rider reads their offer list, rather than
 * on a timer. A background job would be tidier, but the project runs a single
 * process with no scheduler, and an offer only matters when someone looks.
 */
async function expireStaleOffers(): Promise<number> {
  const result = await query(
    `UPDATE rider_job_offers SET status = 'EXPIRED'
      WHERE status = 'OFFERED' AND expires_at < NOW()`
  );
  return result.rowCount || 0;
}

async function getJobById(jobId: string): Promise<RiderJob | null> {
  const result = await query<any>(
    `SELECT rj.*, o.order_number, COALESCE(o.total_weight_kg, 0) AS total_weight_kg
       FROM rider_jobs rj
       JOIN orders o ON o.id = rj.order_id
      WHERE rj.id = ?`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    order_id: String(row.order_id),
    order_number: row.order_number,
    job_type: row.job_type,
    status: row.status,
    rider_id: row.rider_id ? String(row.rider_id) : null,
    latitude: toNum(row.latitude),
    longitude: toNum(row.longitude),
    address_text: row.address_text,
    contact_name: row.contact_name,
    contact_mobile: row.contact_mobile,
    handover_code: row.handover_code,
    origin_latitude: toNum(row.origin_latitude),
    origin_longitude: toNum(row.origin_longitude),
    origin_address: row.origin_address,
    weight_kg: Number(row.total_weight_kg || 0),
    created_at: row.created_at,
  };
}

function formatDistance(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

export {
  notifyNearbyRidersOfNewOrder,
  createJobForOrder,
  dispatchJob,
  acceptJob,
  declineJob,
  holdJob,
  reclaimStaleHolds,
  redispatchStaleJobs,
  expireStaleOffers,
  findNearbyRiders,
  getJobById,
  formatDistance,
  OFFER_RADIUS_M,
  OFFER_TTL_SECONDS,
  HOLD_MAX_MINUTES,
};
