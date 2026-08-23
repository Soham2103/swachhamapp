import { Asset } from 'expo-asset';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { BusinessOrderDetail } from '../services/businessOrderApi';
import { buildBusinessOrderPdfHtml, buildPdfFileName } from './businessOrderPdfHtml';

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
  const { uri } = await Print.printToFileAsync({
    html: buildBusinessOrderPdfHtml(order, logo),
  });

  // Named for the business first, then the order. See buildPdfFileName.
  const fileName = buildPdfFileName(order.order_number, order.business_name);
  const targetUri = `${FileSystem.cacheDirectory}${encodeURIComponent(fileName)}`;
  try {
    await FileSystem.deleteAsync(targetUri, { idempotent: true });
    await FileSystem.moveAsync({ from: uri, to: targetUri });
    return { uri: targetUri, fileName };
  } catch {
    try {
      await FileSystem.copyAsync({ from: uri, to: targetUri });
      return { uri: targetUri, fileName };
    } catch {
      // Both renames failed. The generated file is still a valid PDF, so the
      // action continues rather than failing outright — only the file name
      // falls back to the one expo-print chose.
      if (__DEV__) console.warn('[OrderPdf] could not rename to', fileName);
      return { uri, fileName };
    }
  }
}

/** Swachham logo, embedded as a data URI so the PDF renders it offline. */
async function getLogoDataUri(): Promise<string | null> {
  try {
    const asset = Asset.fromModule(require('../../assets/swachham-logo.png'));
    await asset.downloadAsync();
    const uri = asset.localUri || asset.uri;
    if (!uri) return null;
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    return `data:image/png;base64,${base64}`;
  } catch {
    return null;
  }
}
