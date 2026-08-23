import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import OrderConfirmationModal from '../../components/OrderConfirmationModal';
import DateStrip from '../../components/business/DateStrip';
import TimeSlotRow from '../../components/business/TimeSlotRow';
import businessOrderApi, { BusinessTimeSlot } from '../../services/businessOrderApi';
import { extractErrorMessage } from '../../services/api';
import {
  useBusinessOrderStore,
  SCHEDULE_REQUIRED_MESSAGE,
  DELIVERY_DATE_REQUIRED_MESSAGE,
  DELIVERY_TIME_REQUIRED_MESSAGE,
} from '../../store/businessOrderStore';
import {
  todayIST,
  dateRange,
  getMinimumDeliveryDate,
  formatLongDateIST,
  formatShortDateIST,
  validatePickupDateTime,
  validateDeliveryDateTime,
} from '../../utils/istDates';

/**
 * Pickup & Delivery — the step between the Cart and the order itself.
 *
 * Its own page in the Cart stack, so the Cart holds nothing but the cart. The
 * Cart screen stays mounted underneath while this is open, which is what
 * keeps every item and quantity intact on the way back.
 *
 * TWO SEPARATE SECTIONS. Pickup and delivery are distinct bookings on
 * distinct days, so they get distinct sections, each with its own date and
 * its own time. Nothing is shared between them but the working day's slots.
 *
 * PROGRESSIVE DISCLOSURE. A section's times appear only after its date is
 * chosen — there is nothing to pick a time on until there is a day, and an
 * empty row of times before then is noise. Delivery dates cannot even be
 * offered until the pickup date is known, because the earliest of them is
 * derived from it.
 *
 * DELIVERY IS OPTIONAL. Continue is gated on the PICKUP alone: a business
 * often does not know when it wants the laundry back at the moment it books
 * the collection, and making it guess produces a wrong date rather than no
 * date. The delivery can be scheduled afterwards from the order. What is not
 * allowed is half a delivery — a date with no time, or a time with no date —
 * so the two are validated as a pair whenever either is set.
 *
 * IST EVERYWHERE. Every date and every cutoff comes from `utils/istDates`,
 * never from the device's own calendar. The server re-checks all of it in
 * `pickupSlot.service.ts`, and the server is what decides.
 */

/** How many days ahead each strip offers, from its own first day. */
const DAY_COUNT = 7;

export default function BusinessTimeSlotScreen({ navigation }: any) {
  const { confirmOrder, isPlacingOrder, cart } = useBusinessOrderStore();

  // Nothing is preselected: choosing the pickup date is the first thing to do
  // here, and it is what reveals the rest of the page.
  const [pickupDate, setPickupDate] = useState<string | null>(null);
  const [pickupSlotId, setPickupSlotId] = useState<string | null>(null);
  const [deliveryDate, setDeliveryDate] = useState<string | null>(null);
  const [deliverySlotId, setDeliverySlotId] = useState<string | null>(null);

  /** Optional free text, kept alongside the slots and sent with the order. */
  const [pickupNotes, setPickupNotes] = useState('');
  const [serviceNotes, setServiceNotes] = useState('');

  /**
   * Slots are fetched per date, because availability depends on the date: on
   * today the server marks the slots that have already started unavailable.
   * The two legs are held separately so a pickup on today and a delivery on a
   * later day each get their own answer.
   */
  const [pickupSlots, setPickupSlots] = useState<BusinessTimeSlot[]>([]);
  const [deliverySlots, setDeliverySlots] = useState<BusinessTimeSlot[]>([]);
  const [isLoadingPickupSlots, setIsLoadingPickupSlots] = useState(false);
  const [isLoadingDeliverySlots, setIsLoadingDeliverySlots] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [error, setError] = useState('');

  /** Set once the order is placed; drives the existing confirmation panel. */
  const [placedOrder, setPlacedOrder] = useState<{
    number: string;
    pickupDate: string;
    pickupSlot: string;
    deliveryDate: string;
    deliverySlot: string;
  } | null>(null);

  /**
   * Pickup days start at today IN IST — read at render, so a screen left open
   * across midnight offers the new Indian day rather than a stale one.
   */
  const pickupDays = useMemo(() => dateRange(todayIST(), DAY_COUNT), []);

  /**
   * Delivery days start the day AFTER the chosen pickup, and are recomputed
   * whenever that pickup changes. Same-day delivery is therefore not offered
   * at all — it is absent from the strip, not merely rejected on tap.
   */
  const deliveryDays = useMemo(
    () => (pickupDate ? dateRange(getMinimumDeliveryDate(pickupDate), DAY_COUNT) : []),
    [pickupDate]
  );

  const loadSlots = useCallback(
    async (date: string, leg: 'pickup' | 'delivery') => {
      const setLoading = leg === 'pickup' ? setIsLoadingPickupSlots : setIsLoadingDeliverySlots;
      const setSlots = leg === 'pickup' ? setPickupSlots : setDeliverySlots;
      try {
        setSlotsError('');
        setLoading(true);
        // The server answers for THIS date, so the row can never show a slot
        // the order endpoint would refuse.
        const response = await businessOrderApi.getTimeSlots(date);
        setSlots(response.data || []);
      } catch (err: any) {
        setSlots([]);
        setSlotsError(extractErrorMessage(err, 'Could not load time slots. Please try again.'));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (pickupDate) loadSlots(pickupDate, 'pickup');
  }, [pickupDate, loadSlots]);

  useEffect(() => {
    if (deliveryDate) loadSlots(deliveryDate, 'delivery');
  }, [deliveryDate, loadSlots]);

  /**
   * Choosing a pickup date re-evaluates everything downstream of it, because
   * the earliest delivery date is derived from it.
   */
  const handlePickupDate = (dateKey: string) => {
    setPickupDate(dateKey);
    // A different day has a different cutoff, so the pickup time is re-chosen.
    setPickupSlotId(null);

    // A delivery date that is still after the new pickup stays, and so do its
    // slots — they were loaded for that date and are unaffected by the pickup
    // moving. Anything else is no longer a valid delivery and is cleared
    // whole, so a stale date can never survive a pickup change.
    const deliveryStillValid = Boolean(deliveryDate && deliveryDate > dateKey);
    if (!deliveryStillValid) {
      setDeliveryDate(null);
      setDeliverySlotId(null);
      setDeliverySlots([]);
    }
    setError('');
  };

  const handleDeliveryDate = (dateKey: string) => {
    setDeliveryDate(dateKey);
    setDeliverySlotId(null);
    setError('');
  };

  const labelOf = (slots: BusinessTimeSlot[], id: string | null) =>
    (id && slots.find((slot) => slot.id === id)?.label) || null;

  const pickupSlot = pickupSlots.find((slot) => slot.id === pickupSlotId) || null;
  const deliverySlot = deliverySlots.find((slot) => slot.id === deliverySlotId) || null;
  const pickupLabel = labelOf(pickupSlots, pickupSlotId);
  const deliveryLabel = labelOf(deliverySlots, deliverySlotId);

  // Continue needs the pickup and nothing else. A delivery that has been
  // half-entered still blocks it, because that is an unfinished edit rather
  // than a decision to skip.
  const deliveryHalfEntered =
    (Boolean(deliveryDate) && !deliverySlotId) || (!deliveryDate && Boolean(deliverySlotId));
  const isReady = Boolean(pickupDate && pickupSlotId) && !deliveryHalfEntered;

  /**
   * Places the order.
   *
   * Each rule is checked in the order the user meets it and reported in its
   * own words, so "what is missing" is never a guess. The server enforces the
   * identical set, so a request that skipped this screen is refused too — the
   * checks here exist to answer sooner, not to be the authority.
   */
  const handleContinue = async () => {
    if (isPlacingOrder) return;

    const pickupProblem = validatePickupDateTime(pickupDate, pickupSlot);
    if (pickupProblem) {
      setError(!pickupDate || !pickupSlotId ? SCHEDULE_REQUIRED_MESSAGE : pickupProblem);
      return;
    }
    // Delivery is optional, but not half-optional: a date on its own is an
    // unfinished choice and is reported as the missing time, and vice versa.
    if (deliveryDate && !deliverySlotId) {
      setError(DELIVERY_TIME_REQUIRED_MESSAGE);
      return;
    }
    if (!deliveryDate && deliverySlotId) {
      setError(DELIVERY_DATE_REQUIRED_MESSAGE);
      return;
    }
    if (deliveryDate && deliverySlotId) {
      const deliveryProblem = validateDeliveryDateTime(pickupDate, deliveryDate, deliverySlot);
      if (deliveryProblem) {
        setError(deliveryProblem);
        return;
      }
    }

    try {
      setError('');
      const order = await confirmOrder({
        pickupDate: pickupDate!,
        pickupSlot: pickupSlotId!,
        // Null, not undefined: "deliberately not scheduled" is a state the
        // server stores, not a field that went missing.
        deliveryDate: deliveryDate || null,
        deliverySlot: deliverySlotId || null,
        // Both optional: an empty note is simply not stored.
        pickupNotes: pickupNotes.trim(),
        serviceNotes: serviceNotes.trim(),
      });
      setPlacedOrder({
        number: order.order_number,
        pickupDate: formatLongDateIST(order.pickup?.date || pickupDate!),
        pickupSlot: order.pickup?.slot_label || pickupLabel || '',
        deliveryDate: order.delivery?.date
          ? formatLongDateIST(order.delivery.date)
          : deliveryDate
            ? formatLongDateIST(deliveryDate)
            : '',
        deliverySlot: order.delivery?.slot_label || deliveryLabel || '',
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to place order');
    }
  };

  /** The read-only field that shows what a strip has selected. */
  const dateField = (value: string | null, placeholder: string) => (
    <View style={[styles.dateField, !value && styles.dateFieldEmpty]}>
      <Ionicons
        name="calendar-outline"
        size={16}
        color={value ? COLORS.PrimaryDark : COLORS.TextSecondary}
      />
      <Text style={[styles.dateFieldText, !value && styles.dateFieldTextEmpty]}>
        {value ? formatShortDateIST(value) : placeholder}
      </Text>
    </View>
  );

  const slotsBusy = (loading: boolean) =>
    loading ? (
      <View style={styles.inlineLoading}>
        <ActivityIndicator size="small" color={COLORS.Primary} />
        <Text style={styles.hintTextSmall}>Loading times...</Text>
      </View>
    ) : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to cart"
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.PrimaryDark} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Pickup & Delivery</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* ================= PICKUP DETAILS ================= */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Pickup Details</Text>

            <Text style={styles.fieldLabel}>
              Pickup Date <Text style={styles.required}>*</Text>
            </Text>
            {dateField(pickupDate, 'Select Date')}
            <DateStrip
              dates={pickupDays}
              selected={pickupDate}
              onSelect={handlePickupDate}
              label="Pickup date"
            />

            {/* Times only exist once there is a day to put them on. */}
            {pickupDate ? (
              <>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>
                  Pickup Time <Text style={styles.required}>*</Text>
                </Text>
                {slotsBusy(isLoadingPickupSlots) || (
                  <TimeSlotRow
                    slots={pickupSlots}
                    selectedId={pickupSlotId}
                    onSelect={(id) => {
                      setPickupSlotId(id);
                      setError('');
                    }}
                    label="Pickup time"
                    emptyText="No pickup times left today. Please choose a later date."
                  />
                )}
              </>
            ) : (
              <Text style={styles.hintTextSmall}>Select a pickup date to see the times.</Text>
            )}
          </View>

          {/* ================= DELIVERY DETAILS ================= */}
          <View style={styles.card}>
            <View style={styles.sectionHeadRow}>
              <Text style={styles.sectionTitle}>Delivery Details</Text>
              <Text style={styles.optionalBadge}>OPTIONAL</Text>
            </View>
            <Text style={styles.sectionHint}>
              You can skip this and choose the delivery slot later from your order.
            </Text>

            {!pickupDate ? (
              <Text style={styles.hintTextSmall}>
                Choose a pickup date first — delivery starts the day after it.
              </Text>
            ) : (
              <>
                <Text style={styles.fieldLabel}>Delivery Date</Text>
                {dateField(deliveryDate, 'Select Date')}
                <DateStrip
                  dates={deliveryDays}
                  selected={deliveryDate}
                  onSelect={handleDeliveryDate}
                  label="Delivery date"
                />

                {deliveryDate ? (
                  <TouchableOpacity
                    style={styles.clearDelivery}
                    onPress={() => {
                      setDeliveryDate(null);
                      setDeliverySlotId(null);
                      setDeliverySlots([]);
                      setError('');
                    }}
                    accessibilityLabel="Clear the delivery date and time"
                  >
                    <Ionicons name="close-circle-outline" size={14} color={COLORS.TextSecondary} />
                    <Text style={styles.clearDeliveryText}>Clear delivery, schedule later</Text>
                  </TouchableOpacity>
                ) : null}

                {deliveryDate ? (
                  <>
                    {/* Required only once a delivery date exists: at that
                        point the delivery is being booked, so it needs both. */}
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>
                      Delivery Time <Text style={styles.required}>*</Text>
                    </Text>
                    {slotsBusy(isLoadingDeliverySlots) || (
                      <TimeSlotRow
                        slots={deliverySlots}
                        selectedId={deliverySlotId}
                        onSelect={(id) => {
                          setDeliverySlotId(id);
                          setError('');
                        }}
                        label="Delivery time"
                      />
                    )}
                  </>
                ) : (
                  <Text style={styles.hintTextSmall}>
                    Select a delivery date to see the times.
                  </Text>
                )}
              </>
            )}
          </View>

          {slotsError ? (
            <View style={styles.errorBlock}>
              <Text style={styles.errorText}>{slotsError}</Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => {
                  if (pickupDate) loadSlots(pickupDate, 'pickup');
                  if (deliveryDate) loadSlots(deliveryDate, 'delivery');
                }}
                activeOpacity={0.85}
              >
                <Ionicons name="refresh" size={16} color={COLORS.Surface} />
                <Text style={styles.retryText}>RETRY</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* ================= NOTES ================= */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Pickup And Drop Notes</Text>
            <TextInput
              style={styles.noteInput}
              value={pickupNotes}
              onChangeText={setPickupNotes}
              placeholder="Type Instruction"
              placeholderTextColor={COLORS.TextSecondary}
              multiline
              maxLength={500}
              textAlignVertical="top"
              accessibilityLabel="Pickup and drop notes"
            />

            <Text style={[styles.cardTitle, styles.noteHeadingSpacing]}>
              Laundry service Notes
            </Text>
            <TextInput
              style={styles.noteInput}
              value={serviceNotes}
              onChangeText={setServiceNotes}
              placeholder="Type Instruction"
              placeholderTextColor={COLORS.TextSecondary}
              multiline
              maxLength={500}
              textAlignVertical="top"
              accessibilityLabel="Laundry service notes"
            />
          </View>

          {/* What is about to be booked, in the order it was chosen. */}
          <View style={styles.summaryCard}>
            <SummaryLine
              label="Pickup"
              value={
                pickupDate ? `${formatShortDateIST(pickupDate)}${pickupLabel ? ` · ${pickupLabel}` : ''}` : null
              }
            />
            <SummaryLine
              label="Delivery"
              value={
                deliveryDate
                  ? `${formatShortDateIST(deliveryDate)}${deliveryLabel ? ` · ${deliveryLabel}` : ''}`
                  : null
              }
              /* Not an error: leaving it unset is a supported choice here. */
              missingText="To be scheduled later"
              missingIsOk
            />
            <SummaryLine
              label="Items"
              value={cart?.items?.length ? String(cart.items.length) : '0'}
            />
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
            style={[styles.continueButton, (!isReady || isPlacingOrder) && styles.buttonDisabled]}
            onPress={handleContinue}
            /* Disabled for the whole round trip, so a second tap cannot send a
               second order. Left tappable while incomplete so pressing it
               explains what is missing instead of doing nothing. */
            disabled={isPlacingOrder}
            activeOpacity={0.85}
          >
            {isPlacingOrder ? (
              <>
                <ActivityIndicator size="small" color={COLORS.Surface} />
                <Text style={styles.continueText}>Placing Order...</Text>
              </>
            ) : (
              <>
                <Text style={styles.continueText}>Continue</Text>
                <Ionicons name="arrow-forward" size={20} color={COLORS.Surface} />
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* The existing branded confirmation, now showing both dates. */}
      <OrderConfirmationModal
        visible={Boolean(placedOrder)}
        orderNumber={placedOrder?.number || ''}
        pickupDate={placedOrder?.pickupDate}
        pickupSlot={placedOrder?.pickupSlot}
        deliveryDate={placedOrder?.deliveryDate}
        deliverySlot={placedOrder?.deliverySlot}
        onViewOrders={() => {
          setPlacedOrder(null);
          navigation.navigate('BusinessOrders');
        }}
        onClose={() => {
          setPlacedOrder(null);
          // The cart is empty now, so there is nothing to come back to.
          navigation.goBack();
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
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Background,
  },
  headerTitle: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
  },

  content: { padding: SPACING.md, paddingBottom: SPACING.xl },

  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Border,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  /** The heading of one booking section, e.g. "Pickup Details". */
  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
    marginBottom: SPACING.sm,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.sm,
  },
  fieldLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.xs,
  },
  fieldLabelSpaced: { marginTop: SPACING.md },
  required: { color: COLORS.Error },

  // ---- The selected-date readout above each strip ----
  dateField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    height: 40,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Primary,
    backgroundColor: '#F1F9F4',
    marginBottom: SPACING.sm,
  },
  dateFieldEmpty: { borderColor: COLORS.Border, backgroundColor: COLORS.Background },
  dateFieldText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
  },
  dateFieldTextEmpty: { fontWeight: '600', color: COLORS.TextSecondary },

  // ---- Notes ----
  noteInput: {
    minHeight: 96,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Background,
    padding: SPACING.md,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  noteHeadingSpacing: { marginTop: SPACING.md },

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

  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  optionalBadge: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: COLORS.TextSecondary,
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  sectionHint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: 2,
    marginBottom: SPACING.sm,
  },
  clearDelivery: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: SPACING.xs,
  },
  clearDeliveryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    textDecorationLine: 'underline',
  },

  // ---- States ----
  inlineLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
  },
  hintTextSmall: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    paddingVertical: SPACING.xs,
  },
  errorBlock: {
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#FDECEC',
    marginBottom: SPACING.md,
  },
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
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    minHeight: 40,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
  },
  retryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
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
