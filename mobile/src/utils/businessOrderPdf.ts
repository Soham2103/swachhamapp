import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { printPdfAs } from './pdfFile';
import { BusinessOrderDetail } from '../services/businessOrderApi';
import {
  buildBusinessOrderPdfHtml, buildCombinedOrderPdfHtml, buildPdfFileName,
} from './businessOrderPdfHtml';

/*
 * The document itself lives in `businessOrderPdfHtml`, which has no Expo
 * imports and can therefore be built and checked off-device. It is re-exported
 * here so every existing import of this module keeps working unchanged.
 */
export * from './businessOrderPdfHtml';

/**
 * Business Order PDF.
 *
 * ONE generator — `generateOrderPdf` — behind both Share PDF and Download
 * PDF, so the two actions can never drift apart. It renders the HTML below
 * through expo-print, which produces a real PDF (not HTML with a renamed
 * extension), and names the file after the order number.
 *
 * Everything here is read-only: it renders the order the API already
 * returned and never writes back.
 *
 * Brand mark is always the capitalised word SWACHHAM with "Business of
 * Laundering" directly beneath it, and the existing Swachham logo alongside.
 */

/**
 * The single PDF generator behind both actions.
 *
 * expo-print renders the HTML to a genuine PDF; the file is then renamed to
 * `<order number>.pdf` in the cache directory so Share and Download hand over
 * exactly the same document under exactly the same name. The URI is
 * percent-encoded because an order number contains `#`, which would otherwise
 * be read as a URI fragment.
 */
export async function generateOrderPdf(
  order: BusinessOrderDetail
): Promise<{ uri: string; fileName: string }> {
  const logo = await getLogoDataUri();

  // Named for the business first, then the order. See buildPdfFileName.
  const fileName = buildPdfFileName(order.order_number, order.business_name);

  return printPdfAs(buildBusinessOrderPdfHtml(order, logo), fileName);
}

/**
 * MANY ORDERS, ONE PDF — the Combine Order document.
 *
 * NOT A SECOND GENERATOR. It goes through the same `getLogoDataUri`, the same
 * expo-print call and the same naming as the single-order PDF above, and each
 * order inside it is rendered by the very function that draws the one-order
 * document. What arrives is the existing Order Details page, once per order.
 *
 * THE ORDER OF THE ARRAY IS THE ORDER OF THE PAGES. Sorting belongs to the
 * caller, which knows what it is sorting by; this only lays them out.
 */
export async function generateCombinedOrderPdf(
  orders: BusinessOrderDetail[],
  fileName: string
): Promise<{ uri: string; fileName: string }> {
  const logo = await getLogoDataUri();
  return printPdfAs(buildCombinedOrderPdfHtml(orders, logo), fileName);
}

/*
 * `renameIntoCache` used to live here and is gone.
 *
 * It moved the printed file into the cache, and on Expo Go it could never
 * succeed: the printer writes outside the sandbox expo-file-system grants
 * permissions for, so both the move and the copy were refused before they
 * reached the disk, and every document fell through to the warning. It is
 * replaced by `printPdfAs` in `utils/pdfFile`, which is shared with the batch
 * and socked documents so the three cannot drift apart again. The full
 * explanation is in that file's header.
 */

/**
 * The logo, resolved ONCE per app session.
 *
 * Null is not cached: a run that failed is retried by the next PDF, so one
 * bad moment cannot cost every document afterwards.
 */
let logoDataUri: string | null = null;

/**
 * Swachham logo, embedded as a data URI so the PDF renders it offline.
 *
 * Exported so other PDF generators — `batchDetailsPdf.ts` included — use the
 * same asset instead of loading it a second way.
 *
 * WHY THE PDF READS ITS OWN COPY OF THE MARK.
 *
 * `swachham-logo.png` is the 1254px app icon — 953 KB, which is ~1.3 MB once
 * base64'd into the document. That made the logo NINETY-NINE PERCENT of the
 * HTML handed to `Print.printToFileAsync` (1.31 MB against 8-31 KB of actual
 * order), and the print snapshot is taken whether or not the WebView has
 * finished decoding an image that size — which is why the mark appeared on
 * some order PDFs and not others, from the same code, for the same business.
 * `swachham-logo-pdf.png` is that identical artwork at 328px: 87 KB, still
 * 288 dpi in the 82px box it is drawn into, so nothing about how the logo
 * looks changes and the document no longer races its own decode.
 *
 * The result is held above because every PDF used to re-download, re-read and
 * re-encode the file, giving each one its own fresh chance to fail.
 */
export async function getLogoDataUri(): Promise<string | null> {
  if (logoDataUri) return logoDataUri;
  try {
    const asset = Asset.fromModule(require('../../assets/swachham-logo-pdf.png'));
    await asset.downloadAsync();
    const uri = asset.localUri || asset.uri;
    if (!uri) return null;

    /*
     * `readAsStringAsync` reads FILES. A bundled asset does not always
     * resolve to one — in development it is an http URL served by Metro —
     * and handing it a URL threw, which the catch below turned into a
     * silently logo-less PDF. Anything that is not already a local file is
     * fetched into the cache first and read from there.
     */
    const cached = `${FileSystem.cacheDirectory}swachham-logo-pdf.png`;

    let fileUri = uri;
    if (!fileUri.startsWith('file://')) {
      const info = await FileSystem.getInfoAsync(cached);
      if (!info.exists) await FileSystem.downloadAsync(uri, cached);
      fileUri = cached;
    }

    let base64: string;
    try {
      base64 = await FileSystem.readAsStringAsync(fileUri, { encoding: 'base64' });
    } catch {
      /*
       * A `file://` asset is not necessarily a file we are ALLOWED to read.
       *
       * On Expo Go the asset can resolve into Expo Go's own storage, outside
       * the sandbox expo-file-system grants this experience — the same
       * refusal that broke the PDF caching (see `utils/pdfFile`). It surfaces
       * differently here: the read throws, the catch below returns null, and
       * every document silently renders without its logo.
       *
       * Copying it into our own cache first turns the read into an ordinary
       * in-sandbox one. `downloadAsync` handles a file:// source as well as
       * an http one, so this covers both.
       */
      await FileSystem.downloadAsync(uri, cached);
      base64 = await FileSystem.readAsStringAsync(cached, { encoding: 'base64' });
    }

    logoDataUri = `data:image/png;base64,${base64}`;
    return logoDataUri;
  } catch {
    // A business with no logo, and a logo that could not be read, both leave
    // the document exactly as it was: the header simply omits the image.
    return null;
  }
}
