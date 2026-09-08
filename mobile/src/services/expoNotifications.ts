import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

/**
 * GUARDED ACCESS TO `expo-notifications`.
 *
 * ============================================================
 * WHY THIS FILE EXISTS
 * ============================================================
 *
 * On ANDROID IN EXPO GO the `expo-notifications` module cannot be imported at
 * all. Not "its push functions fail" — the IMPORT ITSELF THROWS, before any of
 * our code runs:
 *
 *   [runtime not ready]: Error: expo-notifications: Android Push notifications
 *   (remote notifications) functionality provided by expo-notifications was
 *   removed from Expo Go with the release of SDK 53.
 *
 * The throw comes from inside the package, not from us. Its entry point pulls
 * in `DevicePushTokenAutoRegistration.fx`, which registers a global push-token
 * subscription at MODULE SCOPE:
 *
 *   node_modules/expo-notifications/build/DevicePushTokenAutoRegistration.fx.js
 *     if (ServerRegistrationModule.getRegistrationInfoAsync) {
 *       addPushTokenListener(async (token) => { ... });   // <- line 78
 *     }
 *
 * `addPushTokenListener` calls `warnOfExpoGoPushUsage()`, which on Android in
 * Expo Go throws rather than warns. That guard is `Platform.OS === 'android'`
 * only — on iOS the same path merely logs a dev warning — which is why this
 * file keys off the platform too.
 *
 * A `try/catch` around the import does not help, and neither does a lazy
 * `require()` at the call site: the side effect runs on FIRST require whatever
 * triggers it, and it is fatal, so the module has to never be required at all.
 * Hence a module we own, that decides once whether requiring it is safe.
 *
 * ============================================================
 * WHAT IS AND IS NOT LOST
 * ============================================================
 *
 * Only REMOTE (push) notifications were removed from Expo Go. Local
 * notifications and the permission prompt still work there in principle — this
 * app uses nothing but those two — but the unconditional import-time throw
 * takes them down with it, so in Expo Go on Android we go without them.
 *
 * That is acceptable HERE and nowhere else, because both callers already treat
 * notifications as strictly optional:
 *
 *   riderStore.announceOffer   a nudge; the offer card in the UI is the source
 *                              of truth and appears either way.
 *   PermissionScreen           an optional permission that does not block the
 *                              user; both call sites discard the result.
 *
 * A DEVELOPMENT BUILD OR A RELEASE BUILD IS UNAFFECTED. `isRunningInExpoGo()`
 * is false there, the real module is returned, and behaviour is exactly what
 * it has always been. This adds a fallback for Expo Go; it removes nothing
 * from the shipped app.
 */

/**
 * Decided once, at first use rather than at import, so this module is itself
 * safe to import from anywhere.
 */
const IS_UNAVAILABLE = Platform.OS === 'android' && isRunningInExpoGo();

type NotificationsModule = typeof import('expo-notifications');

let cached: NotificationsModule | null = null;

/**
 * The `expo-notifications` module, or `null` where importing it would crash.
 *
 * ALWAYS NULL-CHECK THE RESULT. Returning `null` instead of a stub object is
 * deliberate: a stub would silently swallow calls and make a real
 * notifications bug in a dev build look like this Expo Go limitation.
 */
export function getNotifications(): NotificationsModule | null {
  if (IS_UNAVAILABLE) return null;

  // `require` and not a static import, so the module is pulled in only once we
  // know it is safe — a static import would run the side effect regardless.
  if (!cached) {
    cached = require('expo-notifications') as NotificationsModule;
  }

  return cached;
}

/**
 * True when notifications are unavailable because the app is running in Expo
 * Go on Android. Exposed for messaging, so a screen can explain the gap rather
 * than appear broken.
 */
export const notificationsUnavailableInExpoGo = IS_UNAVAILABLE;
