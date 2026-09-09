import type { BatchRecord } from '../services/sorterBatchApi';
import { formatDateTime, formatWeightKg, buildPdfFileName } from './businessOrderPdfHtml';

/**
 * BATCH DETAILS PDF's HTML, and nothing else.
 *
 * Pure on purpose and with no Expo imports, the same separation
 * `businessOrderPdfHtml.ts` uses: the document can be built and inspected
 * without a device. `batchDetailsPdf.ts` is the other half — it renders this
 * HTML through expo-print and shares the result.
 *
 * Renders the batch record exactly as the app already has it (from
 * `getBatchById`); nothing here recalculates a weight, a utilisation
 * percentage or a status.
 *
 * `BatchRecord` is imported as a TYPE ONLY, deliberately. A value import from
 * `sorterBatchApi` would drag in the axios client and make this document
 * un-renderable outside React Native — the labels below are spelled out here
 * instead, and they are the same strings `BATCH_STATUS_LABEL` and
 * `WASHING_GROUP_LABEL` produce.
 */

/** `IN_MACHINE` -> `IN MACHINE`. Matches BATCH_STATUS_LABEL for every value. */
const statusLabel = (status: string) => String(status || '').replace(/_/g, ' ');

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string)
  );

/** The file name, following the same "establishment_batchnumber.pdf" shape the order PDF uses. */
export function buildBatchDetailsPdfFileName(batch: BatchRecord) {
  return buildPdfFileName(batch.batch_number, establishmentName(batch));
}

/**
 * The establishment name shown on the document.
 *
 * A batch is one washing group, but its lines can still belong to more than
 * one business's orders. When they all agree, that one name is shown; when
 * they do not, every distinct name is listed rather than picking one and
 * silently dropping the rest.
 */
function establishmentName(batch: BatchRecord): string {
  const names = Array.from(
    new Set((batch.items || []).map((item) => item.establishment_name).filter(Boolean))
  );
  return names.join(', ') || '-';
}

export function buildBatchDetailsPdfHtml(batch: BatchRecord, logo: string | null): string {
  const { date, time } = formatDateTime((batch.confirmed_at || batch.created_at) as string);

  const rows = (batch.items || [])
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td class="wrap">${escapeHtml(item.establishment_name || '-')}</td>
        <td class="wrap">${escapeHtml(item.item_name)}</td>
        <td class="num">${escapeHtml(item.quantity)}</td>
        <td class="num">${escapeHtml(formatWeightKg(item.weight_kg))}</td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif; color: #1B1B1B; padding: 28px; }
  .head { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #2D6A4F; padding-bottom: 14px; }
  .docbusiness { text-align: center; font-size: 20px; font-weight: 700; color: #1B4332; margin: 16px 0 0; }
  .doctitle { text-align: center; font-size: 15px; font-weight: 700; letter-spacing: 1px;
              text-transform: uppercase; color: #2D6A4F; margin: 2px 0 0; }
  .brand { font-size: 26px; font-weight: 700; color: #2D6A4F; margin: 0; letter-spacing: 1px; }
  .tagline { display: block; font-size: 12px; color: #6B7280; font-weight: 400; letter-spacing: .4px; margin: 2px 0 0; }
  .logo { width: 62px; height: 62px; object-fit: contain;
          border: 1px solid #E5E7EB; border-radius: 8px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #2D6A4F; margin: 22px 0 8px; page-break-after: avoid; }
  .grid { display: flex; flex-wrap: wrap; }
  .cell { width: 50%; padding: 5px 0; font-size: 12px; }
  .k { color: #6B7280; }
  .v { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th { background: #F1F7F3; text-align: left; padding: 8px; border-bottom: 2px solid #D8E6DD; font-size: 11px; text-transform: uppercase; color: #2D6A4F; }
  td { padding: 8px; border-bottom: 1px solid #EDF2EF; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .wrap { word-break: break-word; overflow-wrap: anywhere; }
  .pill { display: inline-block; background: #E8F3EC; color: #1B4332; border-radius: 10px; padding: 3px 10px; font-size: 11px; font-weight: 700; }
  footer { margin-top: 28px; border-top: 1px solid #E5E7EB; padding-top: 10px; text-align: center; color: #9AA3AE; font-size: 10px; }
</style></head><body>
  <div class="head">
    ${logo ? `<img class="logo" src="${logo}" />` : ''}
    <div>
      <p class="brand">SWACHHAM</p>
      <p class="tagline">Business of Laundering</p>
    </div>
  </div>

  <p class="docbusiness">${escapeHtml(establishmentName(batch))}</p>
  <p class="doctitle">Batch Details</p>

  <h2>Batch Information</h2>
  <div class="grid">
    <div class="cell"><span class="k">Batch Number:</span> <span class="v">${escapeHtml(batch.batch_number)}</span></div>
    <div class="cell"><span class="k">Batch Status:</span> <span class="pill">${escapeHtml(statusLabel(batch.status))}</span></div>
    <div class="cell"><span class="k">Date:</span> <span class="v">${escapeHtml(date)}</span></div>
    <div class="cell"><span class="k">Time:</span> <span class="v">${escapeHtml(time)}</span></div>
    <div class="cell"><span class="k">Machine:</span> <span class="v">${escapeHtml(batch.machine_name)} (${escapeHtml(batch.machine_code)})</span></div>
    <div class="cell"><span class="k">Machine Capacity:</span> <span class="v">${escapeHtml(formatWeightKg(batch.capacity_kg))}</span></div>
    <div class="cell"><span class="k">Washing Group:</span> <span class="v">${escapeHtml(batch.washing_group)}</span></div>
    <div class="cell"><span class="k">Total Weight:</span> <span class="v">${escapeHtml(formatWeightKg(batch.total_weight_kg))}</span></div>
    <div class="cell"><span class="k">Utilization:</span> <span class="v">${escapeHtml(batch.utilization_percentage)}%</span></div>
  </div>

  <h2>Items</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Establishment</th><th>Item Name</th><th class="num">Quantity</th><th class="num">Weight</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <footer>Generated by SWACHHAM · ${escapeHtml(date)} ${escapeHtml(time)}</footer>
</body></html>`;
}
