import { printPdfAs } from './pdfFile';
import { getLogoDataUri } from './businessOrderPdf';
import {
  buildSockedDetailsPdfHtml,
  buildSockedDetailsFileName,
  SockedDetailsDocument,
} from './sockedDetailsPdfHtml';

export * from './sockedDetailsPdfHtml';

/**
 * SOCKED DETAILS PDF.
 *
 * Same generator shape as `generateBatchDetailsPdf`: expo-print renders the
 * HTML in `sockedDetailsPdfHtml.ts` to a real PDF, then the file is renamed to
 * a readable name in the cache directory. The logo comes from the one shared
 * resolver so this document loads the asset exactly as the others do.
 *
 * A SEPARATE DOCUMENT from the Order Confirmation PDF, with its own template
 * and its own file name. Nothing here touches that document or its generator.
 *
 * Read-only: it renders counts the app already loaded and writes nothing back.
 */
export async function generateSockedDetailsPdf(
  data: SockedDetailsDocument
): Promise<{ uri: string; fileName: string }> {
  const logo = await getLogoDataUri();
  const fileName = buildSockedDetailsFileName(data.order_number);

  /*
   * The caching used to be written out here, identically to two other
   * generators, and failed on Expo Go for all three. It is now the shared
   * `printPdfAs`; see `utils/pdfFile` for why it failed and what fixes it.
   */
  return printPdfAs(buildSockedDetailsPdfHtml(data, logo), fileName);
}
