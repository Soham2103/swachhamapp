import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import OrderConfirmationModal from '../../components/OrderConfirmationModal';
/* DateStrip and TimeSlotRow are no longer imported here — this screen has no
   date or time to pick. Both components are untouched and still used by the
   rest of the app. */
import businessOrderApi from '../../services/businessOrderApi';
import { useBusinessOrderStore } from '../../store/businessOrderStore';
import { todayIST, addDays } from '../../utils/istDates';

/**
 * Review Order — the step between the Cart and the order itself.
 *
 * Its own page in the Cart stack, so the Cart holds nothing but the cart. The
 * Cart screen stays mounted underneath while this is open, which is what
 * keeps every item and quantity intact on the way back.
 *
 * THE BUSINESS NO LONGER SCHEDULES THE COLLECTION.
 *
 * This page used to carry two booking sections — "Pickup Details" and
 * "Delivery Details" — where the business picked a date and a time for each.
 * Both are gone. A Manager now sets the pickup when they accept the order,
 * which is why the business is not asked to guess at one: a business order is
 * created at PENDING_APPROVAL and waits for that acceptance before anything
 * is committed to.
 *
 * The page is therefore a REVIEW: what is in the order, and one button to
 * place it. The order's lifecycle is untouched — it still runs
 * Order Placed -> Pickup -> Processing -> Out for Delivery -> Delivered, and
 * the tracking screen still shows every one of those stages.
 *
 * THE PROVISIONAL PICKUP BELOW IS TEMPORARY. See `resolveProvisionalPickup`.
 */

/**
 * A placeholder pickup, sent only because the server still insists on one.
 *
 * TODAY the order endpoint rejects a booking with no pickup date and slot —
 * `pickupSlot.service.ts` throws before the order is written. The business
 * side no longer collects either, so one has to be supplied for the order to
 * be accepted at all.
 *
 * It is a PLACEHOLDER, not a promise. The order is created at
 * PENDING_APPROVAL and the Manager sets the real collection when they accept
 * it, overwriting this. Tomorrow's first slot is used rather than one later
 * today, for two reasons: it cannot go stale while the screen is open (a slot
 * today can start, and the server then refuses it), and it never reads as a
 * commitment to collect within the hour.
 *
 * DELETE THIS ONCE THE BACKEND STOPS REQUIRING A PICKUP. When the order
 * endpoint accepts a booking with no schedule and the Manager's accept step
 * writes it instead, this helper and its call site are the whole of what has
 * to be removed here — nothing else on this screen depends on it.
 */
const PROVISIONAL_PICKUP_SLOT_FALLBACK = '09-11';

export default function BusinessTimeSlotScreen({ navigation }: any) {
  const { confirmOrder, isPlacingOrder, cart, laundryType } = useBusinessOrderStore();

  /*
   * No pickup or delivery state lives here any more. The business does not
   * choose either, so there is nothing on this screen to hold — the
   * provisional pickup is resolved at the moment the order is placed and is
   * never shown.
   */

  /*
   * The two free-text note fields that used to live here — "Pickup And Drop
   * Notes" and "Laundry service Notes" — have been removed from the Business
   * order flow, along with the state that backed them. Nothing is sent for
   * them any more; see `handleContinue`.
   */

  const [error, setError] = useState('');

  /** Set once the order is placed; drives the existing confirmation panel. */
  const [placedOrder, setPlacedOrder] = useState<{ number: string } | null>(null);

  /*
   * GUEST LAUNDRY: WHO THE ORDER IS FOR.
   *
   * Asked ONLY on a Guest Laundry order, and never on a Hotel one — a Hotel
   * order does not render the section, does not validate it and sends nothing
   * for it, so that flow is unchanged.
   *
   * READ FROM BOTH SOURCES, ON PURPOSE. The store's `laundryType` is set the
   * moment the type is chosen on the Order Type page and survives every step
   * after it; `cart.laundry_type` is what the server last returned. They
   * normally agree, but the cart object can be null or stale at the instant
   * this screen first renders — and a COMPULSORY selector that quietly does
   * not appear is the worst possible failure here, because the order then
   * cannot be placed and there is nothing on screen explaining why. Either
   * source saying "guest" is enough to show it.
   *
   * Nothing is preselected. The choice is compulsory, and defaulting to
   * either option would let an order be placed for a room or for staff
   * because the user never looked at the section.
   */
  const isGuest = laundryType === 'guest' || cart?.laundry_type === 'guest';
  const [guestFor, setGuestFor] = useState<'ROOM' | 'STAFF' | null>(null);
  const [roomNumber, setRoomNumber] = useState('');
  const [staffDetails, setStaffDetails] = useState('');

  /*
   * WHETHER THE ORDER MAY BE PLACED.
   *
   * A room order needs a room number actually typed — `.trim()`, so spaces
   * are not a room. Staff laundry needs nothing more. A Hotel order is
   * unaffected and stays always-ready, exactly as before.
   */
  const roomNumberValue = roomNumber.trim();
  const staffDetailsValue = staffDetails.trim();
  const guestSelectionComplete =
    !isGuest ||
    (guestFor === 'STAFF' && staffDetailsValue.length > 0) ||
    (guestFor === 'ROOM' && roomNumberValue.length > 0);

  /**
   * Picks the placeholder pickup described at the top of this file.
   *
   * It asks the server which slots exist for tomorrow rather than hardcoding
   * one, so a change to the working day is picked up here for free. The
   * fallback covers only the case where that call fails — an order should not
   * be blocked by a lookup for a value the Manager is going to replace.
   */
  const resolveProvisionalPickup = useCallback(async () => {
    const date = addDays(todayIST(), 1);
    try {
      const response = await businessOrderApi.getTimeSlots(date);
      const slot = (response.data || []).find((option) => option.available);
      return { date, slotId: slot?.id || PROVISIONAL_PICKUP_SLOT_FALLBACK };
    } catch {
      return { date, slotId: PROVISIONAL_PICKUP_SLOT_FALLBACK };
    }
  }, []);

  /**
   * Places the order.
   *
   * There is nothing on this page for the business to get wrong any more, so
   * there is nothing to validate before sending: the cart's own rules (at
   * least one item, every line with a service, a laundry type) are enforced
   * by the store and by the server, exactly as they were.
   */
  const handleContinue = async () => {
    if (isPlacingOrder) return;

    /*
     * The compulsory Guest Laundry selection, checked before anything is
     * sent. The server refuses the same cases with the same wording, so this
     * is the fast path rather than the only guard.
     */
    if (isGuest && !guestFor) {
      setError('Please select Room Number or Staff Laundry.');
      return;
    }
    if (isGuest && guestFor === 'ROOM' && !roomNumberValue) {
      setError('Please enter the room number.');
      return;
    }
    if (isGuest && guestFor === 'STAFF' && !staffDetailsValue) {
      setError('Please enter the staff laundry details.');
      return;
    }

    try {
      setError('');
      // The placeholder the server still requires. The Manager replaces it
      // when they accept the order — see the note at the top of this file.
      const provisional = await resolveProvisionalPickup();

      const order = await confirmOrder({
        pickupDate: provisional.date,
        pickupSlot: provisional.slotId,
        /*
         * NO DELIVERY IS BOOKED. Null, not undefined: "deliberately not
         * scheduled" is a state the server stores, and it is already the
         * supported way to place an order whose delivery comes later.
         */
        deliveryDate: null,
        deliverySlot: null,
        /*
         * GUEST LAUNDRY ONLY: who the order is for. Null on a Hotel order,
         * where the server ignores both — so a Hotel request is exactly the
         * request it was before this field existed.
         */
        guestLaundryFor: isGuest ? guestFor : null,
        guestRoomNumber: isGuest && guestFor === 'ROOM' ? roomNumberValue : null,
        guestStaffDetails: isGuest && guestFor === 'STAFF' ? staffDetailsValue : null,
        /*
         * NO NOTES ARE SENT.
         *
         * `pickupNotes` and `serviceNotes` are gone from the Business payload
         * entirely rather than sent empty. The server reads them with a
         * helper that treats a missing field as no note, so their absence
         * changes nothing about how the order is created — the columns simply
         * take NULL, exactly as they already did for an order placed without
         * notes. Nothing on the backend or in the schema was changed, and
         * notes on existing orders are untouched.
         */
      });
      setPlacedOrder({ number: order.order_number });
    } catch (err: any) {
      setError(err?.message || 'Failed to place order');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topLogoWrap}>
        <Image
          source={require('../../../assets/swachham-header-logo.png')}
          style={styles.topLogo}
          resizeMode="contain"
          accessibilityLabel="Swachham"
        />
      </View>
      <View style={styles.header}>
        {/* Matches the labelled pill BusinessHeader draws on every other
            Business screen. This screen keeps its own compact header — it has
            no brand row — but the Back control must not be a different one. */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back to cart"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.PrimaryDark} />
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        {/* Renamed with the booking sections: the page no longer schedules a
            pickup or a delivery, so a title promising both would be the sort
            of leftover label the removal was meant to get rid of. */}
        <Text style={styles.headerTitle}>Review Order</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* The "Pickup Details" and "Delivery Details" cards stood here.
              Both are gone whole — heading, date strip and time row — rather
              than emptied, so the summary is now the first card on the page
              and there is no orphaned panel, divider or gap above it. */}

          {/* What is in the order. */}
          {/* The Pickup and Delivery lines that sat above Items are gone with
              the sections that fed them: with nothing chosen here, they could
              only have printed a placeholder the business never picked. */}
          <View style={styles.summaryCard}>
            <SummaryLine
              label="Items"
              value={cart?.items?.length ? String(cart.items.length) : '0'}
            />
            {/* The "Total Weight" line stood here. Removed from this review
                only: `cart.total_weight_kg` is still returned by the server
                and still carried on the cart for the rest of the app. */}
          </View>

          {/* GUEST LAUNDRY ONLY: who the order is for.
              Gated on `isGuest` above, so a Hotel order does not show it at
              all. There is deliberately no "Laundry Type" heading — the two
              options say what they are. */}
          {isGuest && (
            <View style={styles.guestCard}>
              <Text style={styles.guestHeading}>
                This order is for <Text style={styles.required}>*</Text>
              </Text>

              {(
                [
                  { value: 'ROOM' as const, label: 'Room Number' },
                  { value: 'STAFF' as const, label: 'Staff Laundry' },
                ]
              ).map((option) => {
                const selected = guestFor === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[styles.guestOption, selected && styles.guestOptionSelected]}
                    onPress={() => {
                      setGuestFor(option.value);
                      /*
                       * Switching clears the OTHER field, so the order can
                       * never carry a room number it is not for, or staff
                       * details on a room order. The server discards the
                       * unused one too; this keeps the screen honest as well.
                       */
                      if (option.value === 'STAFF') setRoomNumber('');
                      else setStaffDetails('');
                      setError('');
                    }}
                    activeOpacity={0.8}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={option.label}
                  >
                    <View style={[styles.radio, selected && styles.radioSelected]}>
                      {selected ? <View style={styles.radioDot} /> : null}
                    </View>
                    <Text style={[styles.guestOptionText, selected && styles.guestOptionTextSelected]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}

              {/* EXACTLY ONE FIELD IS EVER SHOWN — the one belonging to the
                  option that is selected. Both are compulsory. */}
              {guestFor === 'ROOM' && (
                <View style={styles.roomField}>
                  <Text style={styles.roomLabel}>
                    Room Number <Text style={styles.required}>*</Text>
                  </Text>
                  <TextInput
                    style={styles.roomInput}
                    value={roomNumber}
                    onChangeText={(text) => {
                      setRoomNumber(text);
                      setError('');
                    }}
                    placeholder="e.g. 205"
                    placeholderTextColor={COLORS.TextSecondary}
                    maxLength={20}
                    autoCapitalize="characters"
                    accessibilityLabel="Room number"
                  />
                </View>
              )}

              {guestFor === 'STAFF' && (
                <View style={styles.roomField}>
                  <Text style={styles.roomLabel}>
                    Staff Laundry Details <Text style={styles.required}>*</Text>
                  </Text>
                  <TextInput
                    style={styles.roomInput}
                    value={staffDetails}
                    onChangeText={(text) => {
                      setStaffDetails(text);
                      setError('');
                    }}
                    placeholder="Enter details"
                    placeholderTextColor={COLORS.TextSecondary}
                    /* 120, the column's width — a longer value would be
                       truncated by the database rather than by the field. */
                    maxLength={120}
                    accessibilityLabel="Staff laundry details"
                  />
                </View>
              )}
            </View>
          )}

          {/* Says what happens next, in place of the booking the business used
              to make here. Without it the page would simply stop asking for a
              pickup with no explanation of who arranges one. */}
          <View style={styles.scheduleNote}>
            <Ionicons name="information-circle-outline" size={18} color={COLORS.Primary} />
            <Text style={styles.scheduleNoteText}>
              Your collection will be scheduled and confirmed by our team once your
              order is accepted.
            </Text>
          </View>

          {error ? (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={18} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[
              styles.continueButton,
              (isPlacingOrder || !guestSelectionComplete) && styles.buttonDisabled,
            ]}
            onPress={handleContinue}
            /* Disabled for the whole round trip, so a second tap cannot send a
               second order — and, on a Guest order, until the compulsory
               room / staff selection is complete. A Hotel order has nothing
               to complete here and stays enabled exactly as before; the
               cart's own rules are still enforced by the store and reported
               in the error row above. */
            disabled={isPlacingOrder || !guestSelectionComplete}
            activeOpacity={0.85}
          >
            {isPlacingOrder ? (
              <>
                <ActivityIndicator size="small" color={COLORS.Surface} />
                <Text style={styles.continueText}>Placing Order...</Text>
              </>
            ) : (
              <>
                <Text style={styles.continueText}>Place Order</Text>
                <Ionicons name="arrow-forward" size={20} color={COLORS.Surface} />
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* The existing branded confirmation. No pickup or delivery props are
          passed any more: the modal already renders that block only when it
          is given one, so it now shows the order number alone rather than a
          collection time nobody chose. The component itself is unchanged and
          still supports those props for any other caller. */}
      <OrderConfirmationModal
        visible={Boolean(placedOrder)}
        orderNumber={placedOrder?.number || ''}
        onViewOrders={() => {
          setPlacedOrder(null);
          navigation.navigate('BusinessOrders');
        }}
        onClose={() => {
          setPlacedOrder(null);
          /*
           * HOME, NOT BACK. The cart was cleared by `confirmOrder` and the
           * order is confirmed, so there is nothing behind this screen to
           * return to — going back landed the user in a checkout flow for an
           * order they had just placed.
           *
           * NESTED ON PURPOSE. This screen is in BusinessCartStack and the
           * home page is HomeScreen inside BusinessHomeStack, a different
           * tab. A bare navigate('HomeScreen') is not handled by this
           * navigator; naming the tab and the screen inside it is what
           * reaches it, and it lands on Home rather than wherever that tab
           * was last left.
           */
          navigation.navigate('BusinessHome', { screen: 'HomeScreen' });
        }}
      />
    </SafeAreaView>
  );
}

function SummaryLine({
  label,
  value,
  missingText = 'Not selected',
  missingIsOk = false,
}: {
  label: string;
  value: string | null;
  /** What to show when there is no value. */
  missingText?: string;
  /** True when "missing" is a legitimate state rather than something wrong. */
  missingIsOk?: boolean;
}) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text
        style={[
          styles.summaryValue,
          !value && (missingIsOk ? styles.summaryValueOptional : styles.summaryValueMissing),
        ]}
      >
        {value || missingText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },

  topLogoWrap: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: SPACING.xs,
    backgroundColor: 'transparent',
  },
  topLogo: {
    width: '100%',
    height: 70,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.Surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 1.5,
    borderColor: COLORS.Primary,
  },
  backButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
  },
  headerTitle: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
  },

  content: { padding: SPACING.md, paddingBottom: SPACING.xl },

  /*
   * The booking sections' styles are gone with the sections themselves:
   * `card`, `sectionTitle`, `sectionHeadRow`, `optionalBadge`, `sectionHint`,
   * `fieldLabel`, `fieldLabelSpaced`, `required`, the `dateField*` set,
   * `clearDelivery*`, `hintTextSmall`, `inlineLoading`, `errorBlock`,
   * `retryButton`/`retryText`, and the notes card's `cardTitle`, `noteInput`
   * and `noteHeadingSpacing`. Every one of them was used only by the removed
   * markup, so none is left behind as a dead rule.
   */

  /** What happens next, in place of the booking the business used to make. */
  scheduleNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#F1F9F4',
    borderWidth: 1,
    borderColor: COLORS.Accent,
    marginBottom: SPACING.md,
  },
  scheduleNoteText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    lineHeight: 19,
    color: COLORS.TextPrimary,
  },

  // ---- Guest Laundry: who the order is for ----
  guestCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1.5,
    borderColor: COLORS.Primary,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  guestHeading: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
    marginBottom: SPACING.sm,
  },
  required: { color: COLORS.Error },
  guestOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1.5,
    borderColor: COLORS.Border,
    marginBottom: SPACING.xs,
  },
  guestOptionSelected: { borderColor: COLORS.Primary, backgroundColor: '#F1F9F4' },
  guestOptionText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  guestOptionTextSelected: { fontWeight: '800', color: COLORS.PrimaryDark },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.Border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: COLORS.Primary },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.Primary,
  },
  roomField: { marginTop: SPACING.xs },
  roomLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextSecondary,
    marginBottom: 4,
  },
  roomInput: {
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1.5,
    borderColor: COLORS.Primary,
    backgroundColor: COLORS.Surface,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },

  // ---- Summary ----
  summaryCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1.5,
    borderColor: COLORS.Primary,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: SPACING.sm,
  },
  summaryLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  summaryValue: {
    flex: 1,
    textAlign: 'right',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  summaryValueMissing: { color: COLORS.Error },
  /* Absent on purpose reads as ordinary text, never as an error. */
  summaryValueOptional: { color: COLORS.TextSecondary, fontWeight: '600' },

  // ---- States ----
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#FDECEC',
  },
  errorText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.Error,
  },
  // ---- Footer ----
  footer: {
    padding: SPACING.md,
    backgroundColor: COLORS.Surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },
  continueButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    minHeight: 56,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
  },
  buttonDisabled: { opacity: 0.5 },
  continueText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },
});
