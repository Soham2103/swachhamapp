/**
 * THE SOCKED DETAILS DOCUMENT.
 *
 * A SECOND, SEPARATE document — it is not the Order Confirmation PDF with
 * different rows in it. The confirmation document and its generator are not
 * touched by anything in this file, and nothing here is imported by them.
 *
 * WHAT IT SHOWS. One line per item of one order, carrying the order number,
 * the item's name, and the socked quantity counted against that item. The
 * quantities come from `pending_item` — what the Sorter actually saved — and
 * are never re-derived from anything on the order itself.
 *
 * No Expo imports, deliberately: the document can then be built and checked
 * off-device, the same arrangement `businessOrderPdfHtml` uses.
 */

/** One item's line on the document. */
export interface SockedDetailRow {
  item_name: string;
  /** As saved against the line. null is "not counted", and prints as such. */
  socked_quantity: number | null;
}

export interface SockedDetailsDocument {
  order_number: string;
  /** The ESTABLISHMENT name, as every Swachham document leads with. */
  business_name: string;
  rows: SockedDetailRow[];
}

/**
 * Escapes text for the document.
 *
 * Its own copy rather than an import: this file is standalone by design, and a
 * shared helper would tie it to the confirmation document's module.
 */
function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The date and time the document was produced, in the reader's own locale.
 *
 * The document states when it was printed and not when the order was placed:
 * it is a snapshot of counts that are still being taken.
 */
function printedAt() {
  const now = new Date();
  return {
    date: now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
  };
}

/*
 * The stylesheet is its own, matching the house look of the existing document
 * — the same green, the same header band, the same table treatment — without
 * importing it. Sharing the constant would mean editing the confirmation
 * document's module, and this document is meant to be independent of it.
 *
 * NOTE: this sits inside a TS template literal, so no backtick may appear in
 * these comments.
 */
const DOC_OPEN = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif; color: #1B1B1B; padding: 28px; }
  .head { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #2D6A4F; padding-bottom: 14px; }
  .logo { width: 82px; height: 82px; object-fit: contain; }
  .brand { font-size: 26px; font-weight: 700; color: #2D6A4F; margin: 0; letter-spacing: 1px; }
  .tagline { display: block; font-size: 12px; color: #6B7280; font-weight: 400; letter-spacing: .4px; margin: 2px 0 0; }
  .docbusiness { text-align: center; font-size: 20px; font-weight: 700; color: #1B4332; margin: 16px 0 0; }
  .doctitle { text-align: center; font-size: 15px; font-weight: 700; letter-spacing: 1px;
              text-transform: uppercase; color: #2D6A4F; margin: 2px 0 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #2D6A4F; margin: 22px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { background: #F3F8F5; color: #1B4332; text-align: left; font-size: 11px; text-transform: uppercase;
       letter-spacing: .5px; padding: 8px; border-bottom: 2px solid #D8E6DD; }
  td { padding: 8px; border-bottom: 1px solid #EDF2EF; vertical-align: top; font-size: 12px; }
  .num { text-align: right; white-space: nowrap; }
  .col-order { width: 26%; }
  .col-item { width: 54%; }
  .col-qty { width: 20%; }
  .qty { font-weight: 700; color: #1B4332; }
  /* A line nobody has counted yet says so, rather than showing a zero that
     would read as a count of none. */
  .uncounted { color: #9AA3AE; font-style: italic; font-weight: 400; }
  .wrap { word-break: break-word; overflow-wrap: anywhere; }
  .empty { font-size: 12px; color: #6B7280; margin: 10px 0 0; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  footer { margin-top: 28px; border-top: 1px solid #E5E7EB; padding-top: 10px; text-align: center; color: #9AA3AE; font-size: 10px; }
</style></head><body>`;

const DOC_CLOSE = `</body></html>`;

/**
 * The Socked Details document for one order.
 *
 * Every item of the order gets a row, including the ones with no count saved
 * yet: a document that silently dropped them would read as though those items
 * had been counted and found empty.
 */
export function buildSockedDetailsPdfHtml(
  data: SockedDetailsDocument,
  logo: string | null
) {
  const { date, time } = printedAt();

  const rows = data.rows
    .map(
      (row) => `
    <tr>
      <td class="wrap">${escapeHtml(data.order_number)}</td>
      <td class="wrap">${escapeHtml(row.item_name)}</td>
      <td class="num">${
        row.socked_quantity === null
          ? '<span class="uncounted">Not counted</span>'
          : `<span class="qty">${escapeHtml(row.socked_quantity)}</span>`
      }</td>
    </tr>`
    )
    .join('');

  const table = data.rows.length
    ? `
  <table>
    <thead>
      <tr>
        <th class="col-order">Order Number</th>
        <th class="col-item">Item Name</th>
        <th class="col-qty num">Socked Quantity</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>`
    : `<p class="empty">This order has no items to report socked quantities for.</p>`;

  return `${DOC_OPEN}
  <div class="head">
    ${logo ? `<img class="logo" src="${logo}" />` : ''}
    <div>
      <p class="brand">SWACHHAM</p>
      <p class="tagline">Business of Laundering</p>
    </div>
  </div>

  <p class="docbusiness">${escapeHtml(data.business_name)}</p>
  <p class="doctitle">Socked Details</p>

  <h2>Socked Details — Order ${escapeHtml(data.order_number)}</h2>
${table}

  <footer>Generated by SWACHHAM · ${escapeHtml(date)} ${escapeHtml(time)}</footer>
${DOC_CLOSE}`;
}

/**
 * The file the document is saved as.
 *
 * Named for the order and for what the document is, so it cannot be mistaken
 * for the order's confirmation PDF in a downloads list. Anything that is not a
 * safe filename character is replaced rather than dropped, so two orders can
 * never collapse onto one name.
 */
export function buildSockedDetailsFileName(orderNumber: string) {
  const safe = String(orderNumber).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `socked-details-${safe || 'order'}.pdf`;
}
