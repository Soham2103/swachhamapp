import { printPdfAs } from './pdfFile';
import { BatchRecord } from '../services/sorterBatchApi';
import { getLogoDataUri } from './businessOrderPdf';
import { buildBatchDetailsPdfHtml, buildBatchDetailsPdfFileName } from './batchDetailsPdfHtml';

export * from './batchDetailsPdfHtml';

/**
 * BATCH DETAILS PDF.
 *
 * Same generator shape as `generateOrderPdf`: expo-print renders the HTML in
 * `batchDetailsPdfHtml.ts` to a real PDF, which `printPdfAs` then places in
 * the cache under a readable name. Read-only — it renders the batch the app
 * already loaded and writes nothing back.
 *
 * The caching used to be written out here, identically to two other
 * generators, and failed on Expo Go for all three. It is now the shared
 * `printPdfAs`; see `utils/pdfFile` for why it failed and what fixes it.
 */
export async function generateBatchDetailsPdf(
  batch: BatchRecord
): Promise<{ uri: string; fileName: string }> {
  const logo = await getLogoDataUri();
  const fileName = buildBatchDetailsPdfFileName(batch);

  return printPdfAs(buildBatchDetailsPdfHtml(batch, logo), fileName);
}
