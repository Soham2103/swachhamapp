import { BusinessOrderDetail } from '../services/businessOrderApi';

/**
 * The Business Order PDF's HTML, and nothing else.
 *
 * Pure on purpose, and in its own file with no Expo imports, so the document
 * the app prints can be built and inspected without a device — which is what
 * `backend/scripts/smoke_documents.ts` does. A layout that can only be seen by
 * printing it on a phone is a layout nobody can check.
 *
 * `businessOrderPdf.ts` is the other half: it takes this HTML, renders it
 * through expo-print, and shares or saves the result.
 *
 * Everything here is read-only. It renders the order the API already returned
 * and never writes back, and it prints NO AMOUNTS — a business order is
 * weight-based from the business's point of view and the API deliberately
 * sends no price, so there is nothing on this document the business was not
 * meant to see.
 */

export const LAUNDRY_LABEL: Record<string, string> = { hotel: 'Hotel Laundry', guest: 'Guest Laundry' };
export const ORDER_LABEL: Record<string, string> = { standard: 'Standard Order', quick: 'Quick Order' };
export const SERVICE_LABEL: Record<string, string> = { wash_iron: 'Wash & Iron', dry_clean: 'Dry Clean' };

/**
 * Weights are stored numerically in kilograms, so the unit is always rendered
 * next to the number. Trailing zeros are trimmed: 2.500 -> "2.5 kg".
 */
export function formatWeightKg(value: unknown) {
  const kg = Number(value ?? 0);
  if (!Number.isFinite(kg)) return '0 kg';
  return `${Number(kg.toFixed(3))} kg`;
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  return {
    date: date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string)
  );

/**
 * PDF file name: the business's ESTABLISHMENT NAME, then the order number.
 *
 *   "CHIRA MEDOWS_SWH#16082026000001.pdf"
 *
 * The establishment name is what the business is known by, so a folder of
 * downloaded orders sorts and reads by business rather than by an opaque
 * number. The order number is kept in full, because it is what identifies the
 * order and what the Order Details page shows.
 *
 * Only characters a filesystem actually rejects are removed. `#`, `-` and
 * spaces are legal on Android and iOS, so they are kept — the name is far more
 * readable with them.
 */
// Reserved on Windows and/or POSIX, plus control characters.
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/** The order number, cleaned for use as a file name, with no extension. */
export function buildPdfBaseName(orderNumber: string, businessName?: string | null) {
  const order = String(orderNumber ?? '')
    .replace(INVALID_FILENAME_CHARS, '')
    .trim() || 'Order';

  const establishment = String(businessName ?? '')
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot or space is legal in the string and rejected by Windows.
    .replace(/[. ]+$/, '')
    .slice(0, 60);

  return establishment ? `${establishment}_${order}` : order;
}

/**
 * The file name both Share PDF and Download PDF use.
 *
 * `businessName` is optional so an older caller that passes only the order
 * number still gets a working name — it simply loses the prefix.
 */
export function buildPdfFileName(orderNumber: string, businessName?: string | null) {
  return `${buildPdfBaseName(orderNumber, businessName)}.pdf`;
}

/**
 * The service for one line. `laundry_service_name` is what the API resolved
 * for that item; there is no order-wide service printed against the rows.
 */
function itemServiceLabel(item: BusinessOrderDetail['items'][number]) {
  return item.laundry_service_name || '-';
}

export function buildBusinessOrderPdfHtml(
  data: BusinessOrderDetail,
  logo: string | null
) {
    const { date, time } = formatDateTime(data.created_at);

    // NO AMOUNTS. A business order is weight-based from the business's
    // point of view: the price is an internal figure used to raise the
    // invoice, and the API deliberately sends none of it here. There is
    // no price column and no totals block, so nothing on this document
    // can show a figure the business was never meant to see.

    /*
     * THE DEFECTIVE ADJUSTMENT, SHOWN ONLY WHEN THERE IS ONE.
     *
     * An order nobody has adjusted prints the table it has always printed:
     * one Qty column, same six headings, same widths. The moment a Sorter
     * records a damaged piece, Qty splits into three — Ordered, Defective,
     * Final — so the document states the movement rather than quietly
     * showing a smaller number than the customer handed over.
     *
     * Gating on `has_adjustment` rather than always splitting is what keeps
     * the existing layout intact for the overwhelming majority of orders,
     * and stops three columns of "10 / 0 / 10" appearing on every document.
     */
    const adjusted = data.has_adjustment === true;

    /*
     * THE STATUS COLUMN, shown only when the order actually has a mixture.
     *
     * A document must not show a pending item as completed, so once part of
     * an order is still being processed each line says which it is. An order
     * where everything is in the same state prints the table it always has —
     * a column reading READY on every row would say nothing.
     */
    const partial = data.has_pending_items === true;

    /**
     * What a line says when the order is split.
     *
     * The QUANTITIES, not just a word: "3 sent / 2 pending" is the fact the
     * reader needs, and a bare "Pending" against a line of five would leave
     * them guessing whether any of it arrived at all.
     */
    const statusCell = (item: BusinessOrderDetail['items'][number]) => {
      if (item.pending_quantity <= 0) return 'Ready';
      if (item.delivery_quantity <= 0) return `Pending (${item.pending_quantity})`;
      return `${item.delivery_quantity} sent / ${item.pending_quantity} pending`;
    };

    const rows = data.items
      .map(
        (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td class="wrap">${escapeHtml(item.service_name)}</td>
        <td class="wrap">${escapeHtml(item.category_name || '-')}</td>
        <td class="wrap">${escapeHtml(itemServiceLabel(item))}</td>
        ${
          adjusted
            ? `<td class="num">${escapeHtml(item.original_quantity)}</td>
        <td class="num${Number(item.defective_quantity) > 0 ? ' defect' : ''}">${escapeHtml(
                item.defective_quantity
              )}</td>
        <td class="num final">${escapeHtml(item.quantity)}</td>`
            : `<td class="num">${escapeHtml(item.quantity)}</td>`
        }
        <td>${escapeHtml(item.unit)}</td>${
          partial
            ? `
        <td class="${item.pending_quantity > 0 ? 'pending' : 'ready'}">${escapeHtml(
                statusCell(item)
              )}</td>`
            : ''
        }
      </tr>`
      )
      .join('');

    /*
     * ORDER SUMMARY — two counts, and they are different questions.
     *
     *   Total Items     how many distinct lines the order has
     *   Total Quantity  how many pieces those lines add up to
     *
     * Both come from the API, which computes them from the order's own lines,
     * so nothing is counted twice here or drifts from what the app shows.
     */
    const summary = `
  <h2>Order Summary</h2>
  <div class="grid">
    <div class="cell"><span class="k">Total Items:</span> <span class="v">${escapeHtml(
      data.item_count
    )}</span></div>
    <div class="cell"><span class="k">Total Quantity:</span> <span class="v">${escapeHtml(
      data.total_quantity
    )}</span></div>
  </div>${
    // Says plainly what the split columns mean, so the smaller Final Qty is
    // never read as pieces having gone missing.
    adjusted
      ? `
  <p class="adjnote">Defective pieces were found during sorting. Final Qty is what this order is
  billed for; the defective pieces were received and are excluded from the charge.</p>`
      : ''
  }${
    // Pending is not defective: the item is still being worked on and is
    // charged in full, so this says so rather than leaving it to be guessed.
    partial
      ? `
  <p class="adjnote">This order is partially completed. The pieces shown as sent have gone out for
  delivery; the pieces shown as pending are still being processed at Swachham and will follow under
  this same order number. Pending pieces are charged as ordered — they are not defective.</p>`
      : ''
  }`;

    return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif; color: #1B1B1B; padding: 28px; }
  .head { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #2D6A4F; padding-bottom: 14px; }
  .docbusiness { text-align: center; font-size: 20px; font-weight: 700; color: #1B4332;
                 margin: 16px 0 0; }
  .doctitle { text-align: center; font-size: 15px; font-weight: 700; letter-spacing: 1px;
              text-transform: uppercase; color: #2D6A4F; margin: 2px 0 0; }
  .brand { font-size: 26px; font-weight: 700; color: #2D6A4F; margin: 0; letter-spacing: 1px; }
  .tagline { display: block; font-size: 12px; color: #6B7280; font-weight: 400; letter-spacing: .4px; margin: 2px 0 0; }
  .logo { width: 62px; height: 62px; object-fit: contain; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #2D6A4F; margin: 22px 0 8px; }
  .grid { display: flex; flex-wrap: wrap; }
  .cell { width: 50%; padding: 5px 0; font-size: 12px; }
  .k { color: #6B7280; }
  .v { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th { background: #F1F7F3; text-align: left; padding: 8px; border-bottom: 2px solid #D8E6DD; font-size: 11px; text-transform: uppercase; color: #2D6A4F; }
  td { padding: 8px; border-bottom: 1px solid #EDF2EF; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  /* The two adjustment columns, when the table carries them. The defective
     count is the one a reader is looking for, so it is the one that is
     coloured; the final quantity is what the order bills, so it is the one
     that is bold. */
  .defect { color: #B42318; font-weight: 700; }
  /* An item still being processed, so the document never reads as though the
     whole order were finished. */
  .pending { color: #8A5200; font-weight: 700; }
  .ready { color: #1B4332; }
  .final { font-weight: 700; color: #1B4332; }
  /* Long orders paginate cleanly: the column headers repeat on every page,
     a row is never split across a page break, and long item or service names
     wrap instead of overflowing. */
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  .wrap { word-break: break-word; overflow-wrap: anywhere; }
  tfoot td { border-top: 2px solid #D8E6DD; border-bottom: none; padding-top: 10px; }
  .tfoot-label { text-align: right; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; color: #2D6A4F; font-weight: 700; }
  .tfoot-value { font-weight: 700; color: #1B4332; }
  .pill { display: inline-block; background: #E8F3EC; color: #1B4332; border-radius: 10px; padding: 3px 10px; font-size: 11px; font-weight: 700; }
  .adjnote { font-size: 11px; color: #6B7280; margin: 8px 0 0; line-height: 1.5; }
  footer { margin-top: 28px; border-top: 1px solid #E5E7EB; padding-top: 10px; text-align: center; color: #9AA3AE; font-size: 10px; }
</style></head><body>
  <div class="head">
    ${logo ? `<img class="logo" src="${logo}" />` : ''}
    <div>
      <p class="brand">SWACHHAM</p>
      <p class="tagline">Business of Laundering</p>
    </div>
  </div>

  <!-- The BUSINESS, then what the document is, both centred under the
       existing branding. business_name is the ESTABLISHMENT name: the API
       resolves it as the establishment name with the record's own name as the
       fallback, so the legal name is never what leads a document. -->
  <p class="docbusiness">${escapeHtml(data.business_name)}</p>
  <p class="doctitle">Order Details</p>

  <h2>Business Information</h2>
  <div class="grid">
    <div class="cell"><span class="k">Business Name:</span> <span class="v">${escapeHtml(data.business_name)}</span></div>
    <div class="cell" style="width:100%"><span class="k">Address:</span> <span class="v">${escapeHtml(data.business_address || '-')}</span></div>
  </div>

  <h2>Order Information</h2>
  <div class="grid">
    <div class="cell"><span class="k">Order Number:</span> <span class="v">${escapeHtml(data.order_number)}</span></div>
    <div class="cell"><span class="k">Order Status:</span> <span class="pill">${escapeHtml((data.status || '').replace(/_/g, ' '))}</span></div>
    <div class="cell"><span class="k">Order Date:</span> <span class="v">${escapeHtml(date)}</span></div>
    <div class="cell"><span class="k">Order Time:</span> <span class="v">${escapeHtml(time)}</span></div>
    <div class="cell"><span class="k">Laundry Type:</span> <span class="v">${escapeHtml(LAUNDRY_LABEL[data.laundry_type || ''] || '-')}</span></div>
    <div class="cell"><span class="k">Order Type:</span> <span class="v">${escapeHtml(ORDER_LABEL[data.order_type || ''] || '-')}</span></div>
    <div class="cell"><span class="k">Items:</span> <span class="v">${escapeHtml(data.item_count)} (Qty ${escapeHtml(data.total_quantity)})</span></div>

    <!-- WHO PLACED THIS ORDER, and on which number.
         placed_by_mobile is orders.placed_by_mobile and nothing else: the
         number that passed OTP for the session this order was placed in. For
         a business reached on several numbers that is whichever contact
         actually placed it, so an order placed on an alternative contact's
         number prints the alternative contact's number and never the
         primary's.
         "N/A", not a substituted number, when the order carries none -- those
         are orders from before the field existed, and no number is known to
         be the right one for them. -->
    <div class="cell"><span class="k">Placed By:</span> <span class="v">${escapeHtml(data.contact_person_name || '-')}</span></div>
    <div class="cell"><span class="k">Mobile Number:</span> <span class="v">${escapeHtml(data.placed_by_mobile || 'N/A')}</span></div>
  </div>

  <h2>Items</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Item</th><th>Category</th><th>Service</th>${
        adjusted
          ? `<th class="num">Ordered Qty</th><th class="num">Defective Qty</th><th class="num">Final Qty</th>`
          : `<th class="num">Qty</th>`
      }<th>Unit</th>${partial ? `<th>Status</th>` : ''}
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <!-- The label spans everything left of the figure it belongs to, so
             the total sits under Final Qty when the table is split and under
             Qty when it is not. -->
        <td colspan="${adjusted ? 6 : 4}" class="tfoot-label">Total Quantity</td>
        <td class="num tfoot-value">${escapeHtml(data.total_quantity)}</td>
        <td${partial ? ` colspan="2"` : ''}></td>
      </tr>
    </tfoot>
  </table>
${summary}

  <footer>Generated by SWACHHAM · ${escapeHtml(date)} ${escapeHtml(time)}</footer>
</body></html>`;
}
