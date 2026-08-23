import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import superAdminApi from '../services/superAdminApi';

/**
 * Downloads one business's profile PDF and hands it to the share sheet.
 *
 * BUILT ENTIRELY ON THE SERVER. This fetches finished bytes; nothing about the
 * document is assembled here, so what is shared is what is stored. See
 * `businessProfilePdf.service` on the backend for what the page carries and
 * for what it deliberately leaves off — no password, no OTP, no secret.
 *
 * `FileSystem.downloadAsync` makes its own request rather than going through
 * the axios client, so the bearer token is attached explicitly — the same way
 * the GST invoice download already works.
 *
 * It lives here rather than inside a screen because the action moved: it used
 * to sit beside every row of the business list and now belongs to the business
 * VIEW page, and a helper that follows the button is one implementation rather
 * than two that can drift.
 */
export async function downloadBusinessProfilePdf(
  businessId: string,
  businessName: string
): Promise<{ uri: string; shared: boolean }> {
  const headers = await superAdminApi.authHeader();
  const target = `${FileSystem.cacheDirectory}business-profile-${businessId}.pdf`;

  const result = await FileSystem.downloadAsync(
    superAdminApi.businessProfilePdfUrl(businessId),
    target,
    { headers }
  );
  if (result.status !== 200) {
    throw new Error('The server could not generate that PDF.');
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, {
      mimeType: 'application/pdf',
      dialogTitle: `${businessName} — Business Profile`,
      UTI: 'com.adobe.pdf',
    });
    return { uri: result.uri, shared: true };
  }

  return { uri: result.uri, shared: false };
}
