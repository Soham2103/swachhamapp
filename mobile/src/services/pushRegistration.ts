import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import apiClient from './api';
import { getNotifications, notificationsUnavailableInExpoGo } from './expoNotifications';

/**
 * FCM DEVICE REGISTRATION.
 *
 * The server addresses a DEVICE, not an account, so the account-to-device
 * mapping has to be told to it. This file is the whole of the app's side of
 * that: ask permission, get the FCM registration token, hand it to
 * `/api/push/token`, and give it back on sign-out.
 *
 * ============================================================
 * EVERY STEP IS ALLOWED TO FAIL
 * ============================================================
 *
 * Push is an addition to notifications that already arrive durably — a
 * customer's notification row, an establishment's Pickup Approvals message.
 * A denied permission, a device with no Play Services, an offline moment: all
 * of them mean "no push on this handset", and none of them may stop a sign-in.
 * So nothing here throws to its caller and every path returns a reason
 * instead.
 *
 * ============================================================
 * THE DEVICE TOKEN, NOT THE EXPO TOKEN
 * ============================================================
 *
 * `getDevicePushTokenAsync()` returns the RAW FCM registration token, which
 * is what a `firebase-admin` backend sends to. `getExpoPushTokenAsync()`
 * would return an `ExponentPushToken[...]`, which only Expo's relay
 * understands and which our server cannot use. They are easy to confuse and
 * the failure is silent — the token registers fine and no message ever
 * arrives — so it is called out here.
 *
 * ============================================================
 * IT CANNOT WORK IN EXPO GO
 * ============================================================
 *
 * Remote push was removed from Expo Go on Android in SDK 53, which is what
 * `expoNotifications.ts` guards against. A DEVELOPMENT BUILD is required.
 * `registerDeviceForPush` reports that as its reason rather than appearing to
 * succeed.
 */

/**
 * The last token this device registered.
 *
 * Kept so sign-out can hand back the exact token the server holds. Reading it
 * from FCM again at sign-out usually works, but not once notification
 * permission has been revoked — and that is precisely when a stale row would
 * otherwise be left behind, delivering one account's messages to whoever signs
 * in next.
 */
const TOKEN_KEY = 'swachham_fcm_token';

export interface PushRegistrationResult {
  registered: boolean;
  /** Why not, when `registered` is false. Safe to log or show in a dev build. */
  reason?: string;
  /** Whether the SERVER has Firebase credentials. False means it cannot send. */
  pushConfigured?: boolean;
}

/**
 * Android delivers to a CHANNEL, and a message naming one that does not exist
 * is dropped without a sound. The backend sends `channelId: 'default'`, so
 * that channel has to exist before the first message arrives.
 *
 * HIGH importance because the handover code is read out while a rider waits;
 * a low-importance channel would deliver it silently to the tray.
 */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const Notifications = getNotifications();
  if (!Notifications) return;
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Swachham',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    });
  } catch {
    // A channel that cannot be created costs the sound, not the message.
  }
}

/**
 * Registers this handset against the signed-in account.
 *
 * Call AFTER sign-in — the endpoint takes the account from the JWT, so an
 * unauthenticated call has nothing to attach the token to. Calling it again
 * is harmless and is how a rotated token reaches the server.
 */
export async function registerDeviceForPush(): Promise<PushRegistrationResult> {
  if (notificationsUnavailableInExpoGo) {
    return {
      registered: false,
      reason:
        'Push notifications need a development build — Expo Go on Android cannot receive them.',
    };
  }

  const Notifications = getNotifications();
  if (!Notifications) {
    return { registered: false, reason: 'The notifications module is unavailable here.' };
  }

  try {
    // ASKED ONCE, BY THE SYSTEM. `getPermissionsAsync` first so a user who has
    // already decided is not prompted again on every sign-in.
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (!granted) {
      return {
        registered: false,
        reason: 'Notification permission was not granted on this device.',
      };
    }

    await ensureAndroidChannel();

    // The RAW FCM token — see the note at the top of this file.
    const device = await Notifications.getDevicePushTokenAsync();
    const token = String(device?.data || '');
    if (!token) {
      return { registered: false, reason: 'FCM did not return a device token.' };
    }

    const response = await apiClient.post('/api/push/token', {
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      deviceName: Platform.OS === 'ios' ? 'iOS device' : 'Android device',
    });

    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
    } catch {
      // Losing the copy only costs a tidy sign-out; the row still exists and
      // is reassigned the next time this device registers.
    }

    return {
      registered: true,
      pushConfigured: Boolean(response?.data?.data?.pushConfigured),
    };
  } catch (error: any) {
    /*
     * The usual cause on a first run is a build with no `google-services.json`
     * — FCM has no project to register with. Reported, never thrown: a
     * sign-in must not fail because a notification could not be set up.
     */
    const detail =
      error?.response?.data?.message || error?.message || 'Unknown push registration error';
    return { registered: false, reason: String(detail) };
  }
}

/**
 * Hands the device back on sign-out.
 *
 * WHY THIS MATTERS ON A SHARED HANDSET: the row is keyed by the token, so
 * without this the next person to sign in on the same phone would keep
 * receiving the previous account's notifications until they happened to
 * register. Best-effort — a failure here must never block signing out.
 */
export async function unregisterDeviceForPush(): Promise<void> {
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    token = null;
  }
  if (!token) return;

  try {
    // `data` rather than a query string: this is a DELETE with a body, which
    // axios only sends when it is given one explicitly.
    await apiClient.delete('/api/push/token', { data: { token } });
  } catch {
    // The server keeps a row for a device that will simply stop being sent to
    // once FCM reports the token dead.
  }

  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Nothing left to do; the next sign-in overwrites it.
  }
}
