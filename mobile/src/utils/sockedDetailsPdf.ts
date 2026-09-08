import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
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
  const { uri } = await Print.printToFileAsync({
    html: buildSockedDetailsPdfHtml(data, logo),
  });

  const fileName = buildSockedDetailsFileName(data.order_number);
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
      if (__DEV__) console.warn('[SockedDetailsPdf] could not rename to', fileName);
      return { uri, fileName };
    }
  }
}
