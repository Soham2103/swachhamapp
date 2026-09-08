import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { customerOrderApi } from '../../services/customerCartApi';
import PickupScheduleCard from '../../components/PickupScheduleCard';
import {
  CUSTOMER_STAGES, customerStatusLabel, customerStageIndex, isCancelledStatus,
} from '../../constants/orderStatus';

/**
 * TRACK MY ORDER — one order, by its real id.
 *
 * The id arrives in the route params from the order that was actually
 * placed (or from the row tapped in My Orders), and every figure on this
 * screen comes from `GET /api/orders/:id/tracking` for that id. Nothing is
 * carried over from the checkout form, so what is shown is what the server
 * stored rather than what the app hoped it stored.
 *
 * That endpoint used to answer 500 for every order — it was still the
 * original PostgreSQL (`row_to_json`, `json_agg ... FILTER`) running against
 * MySQL. It is fixed in `order.service.ts`; this screen is the first thing
 * that reads it.
 *
 * Re-fetched on focus, so coming back to it after a status change shows the
 * new status rather than the one from when it was first opened.
 */

function when(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

/** `2026-09-01` + `09:00:00`/`11:00:00` -> `1 Sep, 09:00–11:00`. */
function slot(date?: string | null, start?: string | null, end?: string | null): string {
  const day = date ? new Date(date) : null;
  const dayText = day && !Number.isNaN(day.getTime())
    ? day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : '';
  const window = start && end ? `${String(start).slice(0, 5)}–${String(end).slice(0, 5)}` : '';
  return [dayText, window].filter(Boolean).join(', ') || '—';
}

export default function CustomerOrderTrackingScreen({ route, navigation }: any) {
  const orderId = String(route?.params?.orderId ?? '');
  const orderNumber = route?.params?.orderNumber ?? '';

  const [tracking, setTracking] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!orderId) {
      setError('No order was given to track.');
      setLoading(false);
      return;
    }
    try {
      setError('');
      setTracking(await customerOrderApi.getOrderTracking(orderId));
    } catch (e: any) {
      setError(
        e?.response?.data?.message || e.message || 'This order could not be loaded.'
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orderId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /* ---------------------------------------------------------- cancel */

  const [cancelling, setCancelling] = useState(false);

  /**
   * WHETHER CANCEL IS OFFERED IS THE SERVER'S ANSWER.
   *
   * `can_cancel` comes from `canCancelStatus` in `order.service`, the same
   * function that enforces the refusal - so the button cannot be shown for an
   * order the API would then reject.
   */
  const canCancel = tracking?.can_cancel === true;

  const cancelOrder = useCallback(async () => {
    if (!orderId || cancelling) return;
    setCancelling(true);
    setError('');
    try {
      await customerOrderApi.cancelOrder(orderId);
      /*
       * RE-READ, DON'T PATCH. The cancelled status is set by the server and
       * comes back with a new history entry; writing 'CANCELLED' into local
       * state instead would be this screen asserting an outcome it did not
       * witness, and would diverge the moment the rule changed.
       */
      await load();
    } catch (e: any) {
      // A 409 here is the business rule speaking - the order moved on between
      // this screen loading and the tap. Its wording is the right message.
      setError(
        e?.response?.data?.message || e.message || 'This order could not be cancelled.'
      );
      await load();
    } finally {
      setCancelling(false);
    }
  }, [orderId, cancelling, load]);

  const confirmCancel = useCallback(() => {
    Alert.alert(
      'Cancel order',
      'Are you sure you want to cancel this order?',
      [
        // The dismissive option first and marked `cancel`, so the destructive
        // one is never what a stray tap lands on.
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm Cancellation', style: 'destructive', onPress: cancelOrder },
      ]
    );
  }, [cancelOrder]);

  /*
   * The history the SERVER recorded, newest first. Not a fixed ladder of
   * steps with ticks guessed from the current status: an order that was
   * cancelled, or one that skipped a stage, would be drawn wrongly by that
   * and the screen would state something that never happened.
   */
  const history: any[] = Array.isArray(tracking?.status_history)
    ? [...tracking.status_history].reverse()
    : [];

  /** Where the order sits on the customer ladder, from the LIVE status. */
  const stageIndex = customerStageIndex(tracking?.status);
  const cancelled = isCancelledStatus(tracking?.status);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {orderNumber || tracking?.order_number || 'Track order'}
        </Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={COLORS.Error} />
          <Text style={[styles.emptyText, { color: COLORS.Error }]}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
        >
          <View style={[styles.statusCard, cancelled && styles.statusCardCancelled]}>
            <Text style={styles.statusLabel}>CURRENT STATUS</Text>
            {/* THE SERVER'S STATUS, spelled with the app's own vocabulary.
                Never a fixed string: whatever `orders.status` holds right now
                is what this reads. */}
            <Text style={[styles.statusValue, cancelled && styles.statusValueCancelled]}>
              {customerStatusLabel(tracking?.status)}
            </Text>
            {!!tracking?.created_at && (
              <Text style={styles.meta}>Placed {when(tracking.created_at)}</Text>
            )}
          </View>

          {/*
            THE COLLECTION, ONCE A MANAGER HAS ARRANGED ONE.

            Directly under the status because it is the one thing a customer
            opens this screen to find out: when someone is coming.

            IT APPEARS BY ITSELF. Nothing is entered here and nothing is
            polled for it — the two fields come back with the tracking read
            that already runs on every focus, so accepting an order, or
            moving its pickup afterwards, shows up the next time this screen
            is looked at.

            NOTHING IS RENDERED UNTIL THERE IS SOMETHING TO RENDER. The card
            returns null unless both halves are set, so an order still
            waiting on a Manager shows no heading and no empty row — and
            neither does an order placed before pickups were assigned at all.

            A CANCELLED ORDER IS NOT COLLECTED, so the card is suppressed for
            one even if a pickup had been assigned before it was cancelled:
            the line above already says nothing will be collected, and a
            collection time under it would contradict that outright.
          */}
          {!cancelled && (
            <PickupScheduleCard
              date={tracking?.assigned_pickup_date}
              time={tracking?.assigned_pickup_time}
            />
          )}

          {/*
            THE LADDER, LIT FROM THE CURRENT STATUS.

            `customerStageIndex` maps the live status onto one of the seven
            customer-visible stages; everything before it is done, everything
            after is still to come. A cancelled order has no place on the
            ladder - it ended rather than progressed - so the ladder is
            replaced by a single line saying so.
          */}
          {cancelled ? (
            <View style={[styles.card, styles.cancelledNote]}>
              <Ionicons name="close-circle" size={20} color={COLORS.Error} />
              <Text style={styles.cancelledText}>
                This order was cancelled. Nothing will be collected or delivered.
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              {CUSTOMER_STAGES.map((stage, index) => {
                const done = stageIndex >= 0 && index < stageIndex;
                const current = index === stageIndex;
                return (
                  <View key={stage.key}>
                    {index > 0 && <View style={styles.divider} />}
                    <View style={styles.historyRow}>
                      <Ionicons
                        name={
                          current ? 'radio-button-on'
                            : done ? 'checkmark-circle'
                              : 'ellipse-outline'
                        }
                        size={18}
                        color={current || done ? COLORS.Primary : COLORS.TextSecondary}
                      />
                      <View style={styles.flex}>
                        <Text
                          style={[
                            styles.historyStatus,
                            current && styles.stageCurrent,
                            !current && !done && styles.stagePending,
                          ]}
                        >
                          {stage.label}
                        </Text>
                        {/* On the stage the order is actually at, the exact
                            status is named too - "In Process" is the stage,
                            "Washing" is where it really is. */}
                        {current
                          && customerStatusLabel(tracking?.status) !== stage.label && (
                          <Text style={styles.meta}>
                            {customerStatusLabel(tracking?.status)}
                          </Text>
                        )}
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          <View style={styles.card}>
            <Row
              icon="time-outline"
              label="Pickup"
              value={slot(
                tracking?.pickup?.scheduled_date,
                tracking?.pickup?.time_slot_start,
                tracking?.pickup?.time_slot_end
              )}
            />
            <View style={styles.divider} />
            <Row
              icon="cube-outline"
              label="Delivery"
              value={slot(
                tracking?.delivery?.scheduled_date,
                tracking?.delivery?.time_slot_start,
                tracking?.delivery?.time_slot_end
              )}
            />
            <View style={styles.divider} />
            <Row
              icon="cash-outline"
              label="Total"
              value={`₹${Number(tracking?.total_amount ?? 0).toFixed(2)}`}
              strong
            />
          </View>

          <Text style={styles.sectionTitle}>Progress</Text>
          <View style={styles.card}>
            {history.length === 0 ? (
              <Text style={styles.meta}>No updates yet.</Text>
            ) : (
              history.map((entry, index) => (
                <View key={`${entry.status}-${entry.created_at}-${index}`}>
                  {index > 0 && <View style={styles.divider} />}
                  <View style={styles.historyRow}>
                    <Ionicons
                      // The newest entry is where the order is now; the rest
                      // are where it has been.
                      name={index === 0 ? 'radio-button-on' : 'checkmark-circle-outline'}
                      size={18}
                      color={index === 0 ? COLORS.Primary : COLORS.TextSecondary}
                    />
                    <View style={styles.flex}>
                      <Text style={styles.historyStatus}>{customerStatusLabel(entry.status)}</Text>
                      {!!entry.notes && <Text style={styles.meta}>{entry.notes}</Text>}
                    </View>
                    <Text style={styles.meta}>{when(entry.created_at)}</Text>
                  </View>
                </View>
              ))
            )}
          </View>

          {/* Offered only while the server says it may be. An order past the
              cancellable statuses simply has no button, rather than one that
              fails when pressed. */}
          {canCancel && (
            <TouchableOpacity
              style={[styles.cancelBtn, cancelling && styles.cancelBtnDisabled]}
              onPress={confirmCancel}
              disabled={cancelling}
              accessibilityRole="button"
              accessibilityLabel="Cancel this order"
              accessibilityState={{ disabled: cancelling }}
            >
              {cancelling
                ? <ActivityIndicator size="small" color={COLORS.Error} />
                : <Ionicons name="close-circle-outline" size={18} color={COLORS.Error} />}
              <Text style={styles.cancelBtnText}>
                {cancelling ? 'Cancelling...' : 'Cancel Order'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Row({
  icon, label, value, strong,
}: {
  icon: any;
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={18} color={COLORS.Primary} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    padding: SPACING.md, backgroundColor: COLORS.Surface, elevation: 2,
  },
  backButton: { marginRight: SPACING.md },
  title: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  content: { padding: SPACING.md, gap: SPACING.sm },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  emptyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    paddingHorizontal: SPACING.lg,
  },
  statusCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1, borderColor: COLORS.Primary,
    padding: SPACING.md, gap: 2,
  },
  statusLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    letterSpacing: 1,
  },
  statusValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1, borderColor: COLORS.Border,
    paddingHorizontal: SPACING.md,
  },
  divider: { height: 1, backgroundColor: COLORS.Border },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  rowLabel: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
  },
  rowValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
    textAlign: 'right',
    flexShrink: 1,
  },
  rowValueStrong: { fontWeight: 'bold' },
  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    marginTop: SPACING.sm,
  },
  historyRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  historyStatus: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  meta: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    paddingVertical: SPACING.xs,
  },
  statusCardCancelled: { borderColor: COLORS.Error },
  statusValueCancelled: { color: COLORS.Error },
  stageCurrent: { fontWeight: 'bold', color: COLORS.Primary },
  /* A stage not yet reached is dimmed rather than hidden: the whole journey
     is the point of the ladder. */
  stagePending: { color: COLORS.TextSecondary },
  cancelledNote: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md, borderColor: COLORS.Error,
  },
  cancelledText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  cancelBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.xs, marginTop: SPACING.sm,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1, borderColor: COLORS.Error,
    backgroundColor: COLORS.Surface,
  },
  cancelBtnDisabled: { opacity: 0.6 },
  cancelBtnText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Error,
  },
});
