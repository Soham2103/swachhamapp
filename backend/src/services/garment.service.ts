import { getClient, query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { config } from '../config/env';

/**
 * Garment-level barcodes and scan verification.
 *
 * One row per physical piece in `order_garments`, one scan row per garment per
 * stage in `garment_scans`. Every rule that matters is enforced here and by
 * the database, not by the UI:
 *
 *   - a barcode is unique across all orders (UNIQUE KEY on order_garments)
 *   - a garment counts once per stage (UNIQUE KEY on garment_scans)
 *   - an order cannot be accepted until acceptance scanning is complete
 *   - an order cannot go out for delivery until delivery scanning is complete
 *   - delivery may only verify garments that passed acceptance
 */

export type ScanStage = 'ACCEPTANCE' | 'DELIVERY';

/** Statuses this workflow reads, in the project's existing vocabulary. */
export const ORDER_STATUS = {
  confirmed: 'ORDER_PLACED',
  accepted: 'RECEIVED_AT_FACILITY',
  ready: 'READY_FOR_DELIVERY',
  out_for_delivery: 'OUT_FOR_DELIVERY',
} as const;

export interface Garment {
  id: string;
  order_id: string;
  barcode: string;
  item_name: string;
  service_name: string | null;
  weight_kg: number | null;
  piece_no: number;
  accepted_scan_at: Date | null;
  delivery_scan_at: Date | null;
}

export interface ScanStatus {
  order_id: string;
  order_number: string;
  status: string;
  /** Every piece the order was placed for — what acceptance counts. */
  expected_count: number;
  /**
   * The pieces going out with the next dispatch — what delivery counts.
   *
   * Equal to `expected_count` unless the Sorter is holding some back.
   */
  expected_delivery_count: number;
  acceptance_scanned: number;
  delivery_scanned: number;
  acceptance_matched: boolean;
  delivery_matched: boolean;
  garments: Garment[];
}

/**
 * Reserves `count` barcodes in one step. Each reads CL-YYYYMMDD-000001.
 *
 * The daily counter uses the same atomic upsert as the Business order number,
 * except it advances by the whole block at once: LAST_INSERT_ID reports the
 * highest number taken, so this call owns (last - count, last] and no other
 * session can be inside that range. Two orders generated at the same instant
 * still cannot collide, and the UNIQUE key on the column is the backstop.
 *
 * Reserving a block rather than calling this once per piece is what keeps
 * order creation off the network: a 60-piece order used to make 180 round
 * trips just to number its garments, on top of one INSERT each. Against a
 * remote database that alone took ~15 seconds, which is longer than the app
 * waits before giving up.
 */
async function reserveBarcodes(connection: any, count: number): Promise<string[]> {
  if (count <= 0) return [];

  const tz = config.BUSINESS_TZ_OFFSET;

  const [dateRows]: any = await connection.execute(
    `SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)) AS ymd,
            DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y%m%d') AS yyyymmdd`,
    [tz, tz]
  );
  const { ymd, yyyymmdd } = dateRows[0];

  await connection.execute(
    `INSERT INTO garment_barcode_daily_sequence (sequence_date, last_number)
     VALUES (?, LAST_INSERT_ID(?))
     ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + ?)`,
    [ymd, count, count]
  );
  const [seqRows]: any = await connection.execute(`SELECT LAST_INSERT_ID() AS seq`);

  const last = Number(seqRows[0].seq);
  const first = last - count + 1;

  const barcodes: string[] = [];
  for (let number = first; number <= last; number += 1) {
    barcodes.push(`CL-${yyyymmdd}-${String(number).padStart(6, '0')}`);
  }
  return barcodes;
}

/** Rows per INSERT, so a very large order cannot exceed max_allowed_packet. */
const GARMENT_INSERT_CHUNK = 200;

/**
 * Creates one garment row per physical piece of an order.
 *
 * Idempotent: an order that already has garments is left exactly as it is, so
 * this is safe to call whenever an order is opened, and re-running can never
 * re-issue or duplicate a barcode. A garment keeps the same barcode for the
 * whole order lifecycle.
 *
 * Accepts an open connection so it can join the order-creation transaction.
 */
async function generateGarmentsForOrder(
  orderId: string,
  existingConnection?: any
): Promise<number> {
  const connection = existingConnection || (await getClient());
  const ownsConnection = !existingConnection;

  try {
    if (ownsConnection) await connection.beginTransaction();

    const [already]: any = await connection.execute(
      `SELECT COUNT(*) AS n FROM order_garments WHERE order_id = ?`,
      [orderId]
    );
    if (Number(already[0].n) > 0) {
      if (ownsConnection) await connection.commit();
      return 0;
    }

    // The order's own service is the line service when every line shared one;
    // otherwise the item's single supported service is used, exactly as the
    // order detail resolves it. Nothing is invented.
    /*
     * PIECES, NOT BILLABLE QUANTITY.
     *
     * `original_quantity` is how many physical garments the order has, and
     * `quantity` is how many of them are billed — the two differ once a
     * defective adjustment has been recorded, because a damaged towel is
     * still a towel that arrived and still needs a barcode. Generating from
     * `quantity` would leave the defective pieces unlabelled and make the
     * acceptance scan unmatchable.
     *
     * COALESCE for lines written before migration 033, where the current
     * quantity IS the original.
     */
    const [lines]: any = await connection.execute(
      `SELECT oi.id, oi.service_id, oi.service_name, oi.weight_kg,
              COALESCE(oi.original_quantity, oi.quantity) AS quantity,
              COALESCE(
                (SELECT st.name FROM services st WHERE st.id = o.service_id),
                (SELECT MIN(st.name)
                   FROM item_service_types m
                   JOIN services st ON st.id = m.service_id
                  WHERE m.item_id = oi.service_id
                    AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
                 HAVING COUNT(*) = 1)
              ) AS resolved_service
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.order_id = ?
        ORDER BY oi.id ASC`,
      [orderId]
    );

    // Every piece of the order, numbered from one reserved block.
    const pieceCounts = lines.map((line: any) => Math.max(0, Number(line.quantity) || 0));
    const totalPieces = pieceCounts.reduce((sum: number, n: number) => sum + n, 0);
    const barcodes = await reserveBarcodes(connection, totalPieces);

    const rows: any[][] = [];
    lines.forEach((line: any, index: number) => {
      for (let piece = 1; piece <= pieceCounts[index]; piece += 1) {
        rows.push([
          orderId,
          line.id,
          line.service_id,
          barcodes[rows.length],
          line.service_name,
          line.resolved_service || null,
          line.weight_kg,
          piece,
        ]);
      }
    });

    // Bulk INSERT: `query` expands a nested array into VALUES (...),(...),
    // still escaped by the driver. One statement per chunk rather than one
    // per garment.
    let created = 0;
    for (let start = 0; start < rows.length; start += GARMENT_INSERT_CHUNK) {
      const chunk = rows.slice(start, start + GARMENT_INSERT_CHUNK);
      await connection.query(
        `INSERT INTO order_garments
           (order_id, order_item_id, service_id, barcode, item_name, service_name, weight_kg, piece_no)
         VALUES ?`,
        [chunk]
      );
      created += chunk.length;
    }

    if (ownsConnection) await connection.commit();
    if (created) {
      logger.info(`[GarmentService] Generated ${created} garment barcode(s) for order ${orderId}`);
    }
    return created;
  } catch (error) {
    if (ownsConnection) await connection.rollback();
    throw error;
  } finally {
    if (ownsConnection) connection.release();
  }
}

/**
 * Expected garment count = the PHYSICAL pieces of the order.
 *
 * `original_quantity`, not `quantity`: a defective piece is damaged, not
 * missing. It was collected, it carries a barcode and it will be scanned, so
 * counting only the billable pieces would report a fully scanned order as
 * 10/8 and refuse to match. Billing reads `quantity`; the shop floor counts
 * what is on the shelf.
 */
async function getExpectedCount(orderId: string, stage?: ScanStage): Promise<number> {
  /*
   * DELIVERY COUNTS ONLY WHAT IS GOING OUT.
   *
   * Acceptance asks "did everything arrive?", and the answer is every piece
   * the order was placed for. Delivery asks "is everything that is leaving on
   * the van?", and pieces the Sorter is holding back are, by definition, not
   * leaving -- so counting them would make a correctly loaded van read 7/10
   * and refuse to match.
   *
   * `pending_quantity` is 0 on every line nobody has held, so an ordinary
   * order gives the same number for both stages, exactly as before. Callers
   * that pass no stage keep the acceptance meaning, which is what they always
   * had.
   */
  const forDelivery = stage === 'DELIVERY';
  const result = await query<{ expected: number }>(
    forDelivery
      ? `SELECT COALESCE(SUM(GREATEST(
                  COALESCE(original_quantity, quantity) - COALESCE(pending_quantity, 0), 0)), 0)
                AS expected
           FROM order_items WHERE order_id = ?`
      : `SELECT COALESCE(SUM(COALESCE(original_quantity, quantity)), 0) AS expected
           FROM order_items WHERE order_id = ?`,
    [orderId]
  );
  return Number(result.rows[0]?.expected || 0);
}

/**
 * Everything the scanner screen needs: the counts for both stages and the
 * garment list with each piece's scan state.
 */
async function getScanStatus(orderId: string): Promise<ScanStatus> {
  const orderResult = await query<{ id: string; order_number: string; status: string }>(
    `SELECT id, order_number, status FROM orders WHERE id = ?`,
    [orderId]
  );
  const order = orderResult.rows[0];
  if (!order) throw new AppError('Order not found', 404);

  const garmentsResult = await query<any>(
    `SELECT g.id, g.order_id, g.barcode, g.item_name, g.service_name, g.weight_kg, g.piece_no,
            (SELECT s.scanned_at FROM garment_scans s
              WHERE s.garment_id = g.id AND s.stage = 'ACCEPTANCE') AS accepted_scan_at,
            (SELECT s.scanned_at FROM garment_scans s
              WHERE s.garment_id = g.id AND s.stage = 'DELIVERY') AS delivery_scan_at
       FROM order_garments g
      WHERE g.order_id = ?
      ORDER BY g.id ASC`,
    [orderId]
  );

  const garments: Garment[] = garmentsResult.rows.map((row) => ({
    id: String(row.id),
    order_id: String(row.order_id),
    barcode: row.barcode,
    item_name: row.item_name,
    service_name: row.service_name,
    weight_kg: row.weight_kg === null ? null : Number(row.weight_kg),
    piece_no: Number(row.piece_no),
    accepted_scan_at: row.accepted_scan_at,
    delivery_scan_at: row.delivery_scan_at,
  }));

  // Expected comes from the order lines, not from the garment rows, so a
  // failed or partial generation shows up as a mismatch rather than passing.
  //
  // Two figures, because the two stages ask different questions: acceptance
  // counts everything that arrived, delivery counts only what is leaving.
  // They are equal on any order with nothing held back.
  const expected = await getExpectedCount(orderId);
  const expectedForDelivery = await getExpectedCount(orderId, 'DELIVERY');
  const acceptanceScanned = garments.filter((g) => g.accepted_scan_at).length;
  const deliveryScanned = garments.filter((g) => g.delivery_scan_at).length;

  return {
    order_id: String(order.id),
    order_number: order.order_number,
    status: order.status,
    expected_count: expected,
    expected_delivery_count: expectedForDelivery,
    acceptance_scanned: acceptanceScanned,
    delivery_scanned: deliveryScanned,
    acceptance_matched: expected > 0 && acceptanceScanned === expected,
    delivery_matched: expectedForDelivery > 0 && deliveryScanned === expectedForDelivery,
    garments,
  };
}

export interface ScanResult {
  success: true;
  barcode: string;
  garment: { id: string; item_name: string; service_name: string | null };
  scannedCount: number;
  expectedCount: number;
  remainingCount: number;
  quantityMatched: boolean;
  message: string;
}

/**
 * Records one scan.
 *
 * Every rejection below is a distinct, specific error so the scanner can show
 * the right message instead of a generic failure. The garment row is locked
 * for the check-then-insert, and the UNIQUE key on (garment_id, stage) is the
 * final guard if two scans race.
 */
async function scanGarment(
  orderId: string,
  barcodeInput: string,
  stage: ScanStage,
  userId: string
): Promise<ScanResult> {
  const barcode = String(barcodeInput || '').trim();
  if (!barcode) {
    throw new AppError('No barcode was read. Please try again.', 400);
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [orderRows]: any = await connection.execute(
      `SELECT id, order_number, status FROM orders WHERE id = ? FOR UPDATE`,
      [orderId]
    );
    const order = orderRows[0];
    if (!order) throw new AppError('Order not found', 404);

    // Each stage may only run at the right point in the pipeline.
    if (stage === 'ACCEPTANCE' && order.status !== ORDER_STATUS.confirmed) {
      throw new AppError(
        `Acceptance scanning is only available for a confirmed order (this one is "${order.status}").`,
        409
      );
    }
    if (stage === 'DELIVERY' && order.status !== ORDER_STATUS.ready) {
      throw new AppError(
        `Delivery verification is only available for an order that is ready (this one is "${order.status}").`,
        409
      );
    }

    // Barcode lookup is global, which is what separates "belongs to another
    // order" from "not registered".
    const [garmentRows]: any = await connection.execute(
      `SELECT id, order_id, item_name, service_name FROM order_garments WHERE barcode = ? FOR UPDATE`,
      [barcode]
    );
    const garment = garmentRows[0];
    if (!garment) {
      throw new AppError('Barcode not registered.', 404);
    }
    if (String(garment.order_id) !== String(orderId)) {
      throw new AppError('This garment belongs to another order.', 409);
    }

    const [scanRows]: any = await connection.execute(
      `SELECT stage FROM garment_scans WHERE garment_id = ?`,
      [garment.id]
    );
    const stages = new Set(scanRows.map((row: any) => row.stage));

    if (stages.has(stage)) {
      throw new AppError('Garment already scanned.', 409);
    }
    // Delivery verifies what acceptance admitted; a garment that never passed
    // acceptance cannot be signed out for delivery.
    if (stage === 'DELIVERY' && !stages.has('ACCEPTANCE')) {
      throw new AppError('Garment was not verified during acceptance.', 409);
    }

    await connection.execute(
      `INSERT INTO garment_scans (order_id, garment_id, barcode, stage, scanned_by)
       VALUES (?, ?, ?, ?, ?)`,
      [orderId, garment.id, barcode, stage, userId]
    );

    const [countRows]: any = await connection.execute(
      `SELECT COUNT(*) AS n FROM garment_scans WHERE order_id = ? AND stage = ?`,
      [orderId, stage]
    );
    const [expectedRows]: any = await connection.execute(
      // The same split as getExpectedCount: acceptance counts every piece
      // that arrived, delivery counts only the pieces that are leaving.
      stage === 'DELIVERY'
        ? `SELECT COALESCE(SUM(GREATEST(
                    COALESCE(original_quantity, quantity) - COALESCE(pending_quantity, 0), 0)), 0)
                  AS expected
             FROM order_items WHERE order_id = ?`
        : `SELECT COALESCE(SUM(COALESCE(original_quantity, quantity)), 0) AS expected
             FROM order_items WHERE order_id = ?`,
      [orderId]
    );

    await connection.commit();

    const scannedCount = Number(countRows[0].n);
    const expectedCount = Number(expectedRows[0].expected);
    const remainingCount = Math.max(expectedCount - scannedCount, 0);
    const quantityMatched = expectedCount > 0 && scannedCount === expectedCount;

    return {
      success: true,
      barcode,
      garment: {
        id: String(garment.id),
        item_name: garment.item_name,
        service_name: garment.service_name,
      },
      scannedCount,
      expectedCount,
      remainingCount,
      quantityMatched,
      message: quantityMatched
        ? 'Quantity match'
        : `${garment.item_name} scanned. ${remainingCount} remaining.`,
    };
  } catch (error: any) {
    await connection.rollback();
    // The UNIQUE key firing means another scan of the same garment won the
    // race; it is the same situation as the duplicate check above.
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new AppError('Garment already scanned.', 409);
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * The gate the status endpoint calls before it will move an order.
 *
 * Throws unless every expected garment has been scanned for the stage, so a
 * crafted API call cannot skip verification the way a disabled button could.
 */
async function assertStageComplete(orderId: string, stage: ScanStage): Promise<void> {
  // Stage-aware: a delivery run is complete when everything LEAVING has been
  // scanned, not when every piece the order ever had has been.
  const expected = await getExpectedCount(orderId, stage);
  if (expected === 0) {
    throw new AppError('This order has no items to verify.', 409);
  }

  const result = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM garment_scans WHERE order_id = ? AND stage = ?`,
    [orderId, stage]
  );
  const scanned = Number(result.rows[0]?.n || 0);

  if (scanned !== expected) {
    const remaining = Math.max(expected - scanned, 0);
    throw new AppError(
      stage === 'ACCEPTANCE'
        ? `Quantity does not match — ${scanned}/${expected} garments scanned, ${remaining} remaining.`
        : `Quantity does not match — ${remaining} garment${remaining === 1 ? '' : 's'} remaining.`,
      409
    );
  }
}

export {
  generateGarmentsForOrder,
  getScanStatus,
  getExpectedCount,
  scanGarment,
  assertStageComplete,
};
