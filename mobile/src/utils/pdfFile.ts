import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import { isRunningInExpoGo } from 'expo';

/**
 * ===================================================================
 * PRINTING A PDF UNDER A CHOSEN FILE NAME
 * ===================================================================
 *
 * One implementation, used by every generator in the app. It replaces three
 * byte-identical copies of the same broken routine (`businessOrderPdf`,
 * `batchDetailsPdf`, `sockedDetailsPdf`), each of which failed the same way
 * and had to be fixed the same way.
 *
 * ============================================================
 * WHAT WAS ACTUALLY WRONG
 * ============================================================
 *
 * Every PDF logged, on Expo Go:
 *
 *   [OrderPdf] could not rename to COMFORT INN EMERALD_SWH#3008....pdf
 *
 * It was NOT the `#`, the spaces, or the percent-encoding. Those are all
 * handled correctly, and the encoding is REQUIRED — `Uri.parse` reads a bare
 * `#` as the start of a fragment, so an unencoded order number would truncate
 * the path.
 *
 * The cause is WHERE THE TWO FILES LIVE.
 *
 *   expo-print writes to `context.cacheDir/Print/` — on Expo Go that is
 *       /data/user/0/host.exp.exponent/cache/Print/<random>.pdf
 *
 *   `FileSystem.cacheDirectory` is the SCOPED directory of the experience
 *       /data/user/0/host.exp.exponent/cache/ExperienceData/<scope>/
 *
 * The printed file is therefore OUTSIDE the sandbox that expo-file-system
 * grants permissions for. Its native module checks permissions before it
 * touches the disk:
 *
 *   moveAsync  ensurePermission(from/.., WRITE)  -> "isn't movable"
 *   copyAsync  ensurePermission(from,     READ)  -> "isn't readable"
 *
 * so BOTH threw, and the old code fell through to the warning. The rename
 * never got as far as the filesystem, which is why nothing about the name
 * could have fixed it.
 *
 * The new File/Directory API in SDK 54+ is scoped the same way (`copy`
 * validates READ on the source, `move` validates WRITE), so switching APIs
 * does not help either. THE CROSS-SANDBOX READ HAS TO BE AVOIDED ENTIRELY.
 *
 * A development or release build never saw this: there `context.cacheDir` IS
 * the app's cache, the printed file lands inside `cacheDirectory`, and the
 * move is permitted. This is an Expo Go-only failure, which is exactly where
 * it was reported.
 *
 * ============================================================
 * HOW THIS FIXES IT
 * ============================================================
 *
 * By never asking the filesystem to read the out-of-sandbox file. expo-print
 * can hand back the document's BYTES directly (`base64: true`), and writing
 * those into the scoped cache is an ordinary in-sandbox write that needs no
 * permission we do not have.
 *
 * The cheap path is still tried first, because a move is a rename(2) and
 * costs nothing next to base64-encoding a document: on a build where the two
 * directories are the same sandbox, nothing changes. Base64 is requested
 * up front only when we already know the move cannot work.
 *
 * THE FILE NAME IS NEVER TOUCHED. Not sanitised, not shortened, no character
 * replaced, no suffix appended. `encodeURIComponent` is applied to build a
 * valid URI and the native layer decodes it again, so what lands on disk is
 * the exact name the caller asked for — spaces, `#`, underscores and all.
 */

/**
 * Where a named PDF is cached, as a URI.
 *
 * Percent-encoded because the name legitimately contains characters that mean
 * something else in a URI — `#` above all, which would otherwise start a
 * fragment and cut the name in half. The native side decodes this back before
 * it opens the file, so the name ON DISK is the unencoded original.
 */
function cacheUriFor(fileName: string): string {
  return `${FileSystem.cacheDirectory}${encodeURIComponent(fileName)}`;
}

/**
 * Writes the document's bytes into the scoped cache.
 *
 * The path that works on Expo Go: the source file is never read, so the
 * sandbox never refuses us.
 */
async function writeBase64(targetUri: string, base64: string): Promise<void> {
  await FileSystem.writeAsStringAsync(targetUri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Moves the printed file into the cache under `fileName`.
 *
 * Returns false rather than throwing when the sandbox refuses it, so the
 * caller can fall back instead of failing.
 */
async function relocate(printedUri: string, targetUri: string): Promise<boolean> {
  try {
    await FileSystem.moveAsync({ from: printedUri, to: targetUri });
    return true;
  } catch {
    try {
      // A copy needs only READ on the source, so it survives some cases a
      // move does not. It leaves the print temp file behind, which the OS
      // clears with the rest of the cache.
      await FileSystem.copyAsync({ from: printedUri, to: targetUri });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A cache path for a DOWNLOAD, under a directory nothing else has used.
 *
 * WHY THE DIRECTORY IS FRESH EVERY TIME. A downloaded document used to be
 * written to `cacheDirectory/<fileName>` — the same path on every download of
 * the same document. `downloadAsync` overwrites it, so the BYTES were always
 * current, but the URI handed onward never changed: on Android
 * `getContentUriAsync` derives the `content://` URI from the path, and the
 * external PDF viewers Android hands it to cache their render against that
 * URI. Re-opening an invoice after it had been regenerated showed the
 * previous render — a stale document produced from a perfectly fresh file.
 *
 * A directory per download makes the URI unique, so no viewer can have seen
 * it before and there is nothing to serve from a cache.
 *
 * THE FILE NAME IS UNTOUCHED, which is the point of putting the uniqueness in
 * the directory rather than in the name: the share sheet, the saved copy and
 * the print job all still show exactly what the caller asked for.
 *
 * These land in the OS cache directory, which the system clears on its own —
 * the same lifetime the single shared path already had.
 */
export async function freshDownloadTarget(fileName: string): Promise<string> {
  const dir = `${FileSystem.cacheDirectory}dl-${Date.now()}-${Math.floor(Math.random() * 1e6)}/`;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return `${dir}${encodeURIComponent(fileName)}`;
  } catch {
    // A cache directory that cannot be created must not cost the download —
    // fall back to the shared path, which is what this replaced.
    return cacheUriFor(fileName);
  }
}

/**
 * Renders `html` to a PDF and returns it under exactly `fileName`.
 *
 * The returned `uri` is the cached file when it could be placed there, and
 * the printer's own temporary file when it could not. EITHER IS A VALID,
 * COMPLETE PDF: generation, opening, sharing and printing all work on both,
 * so a caching problem can never stop a document being produced or read.
 * `fileName` is what the caller asked for in every case.
 */
export async function printPdfAs(
  html: string,
  fileName: string
): Promise<{ uri: string; fileName: string }> {
  /*
   * On Expo Go the move is known to be refused (see the header), so the bytes
   * are requested with the print rather than after a pointless failed attempt.
   * Everywhere else base64 is not asked for, and the cheap move is used.
   */
  const expectSandboxRefusal = isRunningInExpoGo();

  const printed = await Print.printToFileAsync({
    html,
    base64: expectSandboxRefusal,
  });

  const targetUri = cacheUriFor(fileName);

  /*
   * Clear any earlier copy of this document first, so regenerating one order's
   * PDF replaces it in place instead of failing on an existing file — and
   * without inventing a second name for the same document. `idempotent` makes
   * "there was nothing there" a success.
   */
  try {
    await FileSystem.deleteAsync(targetUri, { idempotent: true });
  } catch {
    // A cache we cannot tidy is not a reason to refuse to print. The write
    // below overwrites, and the fallbacks cover the rest.
  }

  // 1. The cheap path, and the only one needed on a dev or release build.
  if (!expectSandboxRefusal && (await relocate(printed.uri, targetUri))) {
    return { uri: targetUri, fileName };
  }

  // 2. The bytes we already hold, if we asked for them.
  if (printed.base64) {
    try {
      await writeBase64(targetUri, printed.base64);
      return { uri: targetUri, fileName };
    } catch {
      // Fall through: the printed file is still a perfectly good PDF.
    }
  } else {
    /*
     * 3. We did not expect to need the bytes and the move failed anyway.
     *
     * Rendering a second time is wasteful, so it happens only here — on a
     * build where the first two paths were both supposed to work. It keeps
     * the promise that the file name is honoured wherever it possibly can be.
     */
    try {
      const retry = await Print.printToFileAsync({ html, base64: true });
      if (retry.base64) {
        await writeBase64(targetUri, retry.base64);
        return { uri: targetUri, fileName };
      }
    } catch {
      // Fall through to the printed file.
    }
  }

  /*
   * 4. The document exists and is valid; only its name on disk is the
   * printer's. Returning it keeps every button working — this is the
   * behaviour the old code had as its ONLY outcome on Expo Go, and it is now
   * the last resort rather than the norm.
   */
  return { uri: printed.uri, fileName };
}
