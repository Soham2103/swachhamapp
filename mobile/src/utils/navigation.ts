import { Linking, Platform } from 'react-native';

/**
 * ===================================================================
 * GOOGLE MAPS ROUTING for a rider on a job
 * ===================================================================
 *
 * The previous version handed the coordinates to whatever the phone
 * happened to have: `maps://` on iOS opened APPLE Maps, and `geo:` on
 * Android opened a chooser that dropped a pin. Neither started
 * navigation — the rider still had to tap Directions themselves, on a
 * bike, at a junction.
 *
 * This starts TURN-BY-TURN GOOGLE MAPS NAVIGATION directly:
 *
 *   Android   google.navigation:  launches guidance immediately
 *   iOS       comgooglemaps://    Google Maps app, directions mode
 *   fallback  https://www.google.com/maps/dir/?api=1
 *             the official universal URL. Opens the Google Maps app
 *             when it is installed and the browser when it is not, so
 *             a phone without the app still gets a route.
 *
 * THE ORIGIN IS DELIBERATELY OMITTED. Google Maps then routes from the
 * device's LIVE position. Passing our last known ping instead would
 * start the route from wherever the rider was up to twenty seconds ago,
 * which on a moving bike is the wrong junction.
 */

/** Where a rider is being sent. */
export interface RouteTarget {
  latitude?: number | null;
  longitude?: number | null;
  /** Used when there are no coordinates — better than refusing to help. */
  addressText?: string | null;
}

/**
 * The universal Google Maps directions URL.
 *
 * Documented and stable, and the only form that works on every platform
 * including web, so it is what everything else falls back to.
 */
function universalDirectionsUrl(target: RouteTarget): string | null {
  const hasCoords =
    typeof target.latitude === 'number' &&
    typeof target.longitude === 'number' &&
    Number.isFinite(target.latitude) &&
    Number.isFinite(target.longitude);

  if (hasCoords) {
    return (
      'https://www.google.com/maps/dir/?api=1' +
      `&destination=${target.latitude},${target.longitude}` +
      '&travelmode=driving'
    );
  }

  /*
   * NO COORDINATES IS NOT A DEAD END.
   *
   * Businesses onboarded before pickup points were captured have no
   * latitude or longitude, and a rider holding that job still has to get
   * there. Routing to the address TEXT gets Google to do its own geocoding,
   * which is far more use than "this job has no coordinates".
   */
  const text = (target.addressText || '').trim();
  if (text.length > 0) {
    return (
      'https://www.google.com/maps/dir/?api=1' +
      `&destination=${encodeURIComponent(text)}` +
      '&travelmode=driving'
    );
  }

  return null;
}

/** The platform's native Google Maps deep link, when coordinates exist. */
function nativeNavigationUrl(target: RouteTarget): string | null {
  const hasCoords =
    typeof target.latitude === 'number' &&
    typeof target.longitude === 'number' &&
    Number.isFinite(target.latitude) &&
    Number.isFinite(target.longitude);

  if (!hasCoords) return null;

  const destination = `${target.latitude},${target.longitude}`;

  if (Platform.OS === 'android') {
    // Starts guidance straight away rather than showing a preview.
    return `google.navigation:q=${destination}&mode=d`;
  }

  if (Platform.OS === 'ios') {
    return `comgooglemaps://?daddr=${destination}&directionsmode=driving`;
  }

  return null;
}

/**
 * Opens Google Maps routing to the target.
 *
 * Resolves to true when something opened, false when there was nothing
 * usable to route to, so a caller can say so rather than appearing to work.
 *
 * The native link is ATTEMPTED, not probed with `canOpenURL`. On Android 11
 * and later `canOpenURL` returns false for any scheme the app has not
 * declared in a manifest `queries` block, so probing would report "Google
 * Maps is not installed" on phones that plainly have it. Trying the link and
 * catching the failure needs no manifest change and is correct on every
 * version.
 */
export async function openGoogleMapsRoute(target: RouteTarget): Promise<boolean> {
  const universal = universalDirectionsUrl(target);
  if (!universal) return false;

  const native = nativeNavigationUrl(target);

  if (native) {
    try {
      await Linking.openURL(native);
      return true;
    } catch {
      // Google Maps is not installed, or the scheme was refused. Fall through.
    }
  }

  try {
    await Linking.openURL(universal);
    return true;
  } catch {
    return false;
  }
}

/** True when there is anything at all to route to. */
export function canRouteTo(target: RouteTarget): boolean {
  return universalDirectionsUrl(target) !== null;
}
