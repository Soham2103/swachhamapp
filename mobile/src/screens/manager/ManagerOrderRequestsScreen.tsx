import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { sa } from '../superadmin/styles';
import DateStrip from '../../components/business/DateStrip';
import TimeSlotRow from '../../components/business/TimeSlotRow';
import PickupScheduleCard from '../../components/PickupScheduleCard';
import { dateRange, todayIST } from '../../utils/istDates';
import managerApi, {
  ManagerPickupTime, OrderRequestSource, PendingOrderRequest,
} from '../../services/managerApi';

/**
 * ORDER REQUESTS — the Manager's queues, and the pickup they assign.
 *
 * THE TWO PENDING TABS, because there are exactly two sources a booking can
 * come from: a customer (`orders.user_id`) or an establishment
 * (`orders.business_user_id`). The server derives the tab from whichever
 * column is set, so nothing is stored for the split and an order cannot
 * appear in both.
 *
 * A "REQUEST" HERE IS THE ORDER ITSELF, read at status PENDING_APPROVAL. There
 * is no request record beside it, so the order number shown here is the one
 * the Sorter and the Rider will work with after it is accepted — one row, one
 * id, all the way through.
 *
 * ============================================================
 * ACCEPTING NOW MEANS NAMING THE COLLECTION
 * ============================================================
 *
 * A Manager chooses a pickup DATE and TIME on the card before Accept will do
 * anything. The two are one decision — "yes, and we will collect it then" —
 * and the server refuses an acceptance without them, so this is not a
 * courtesy check that could be skipped by a stale build.
 *
 * NOTHING IS PRESELECTED. Defaulting the date to today, or the time to the
 * slot the customer happened to ask for, would let a Manager accept a
 * collection they never actually looked at. Both are deliberate taps.
 *
 * THE TIMES COME FROM THE SERVER, per date, and carry their own availability:
 * on today, one that has already gone by comes back unavailable and the pill
 * is dimmed and unpressable. The same list validates the acceptance, so the
 * picker cannot offer something the server will refuse.
 *
 * ============================================================
 * THE THIRD TAB
 * ============================================================
 *
 * Accepting takes an order out of the pending queues, so a pickup that needs
 * moving afterwards would have nowhere to be moved from. "Scheduled" lists
 * the accepted orders that have not been collected yet, soonest first, and
 * the same picker changes the time on one. The status is not touched: the
 * order keeps its place in the flow and only the collection moves.
 */

type Tab = OrderRequestSource | 'SCHEDULED';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'CUSTOMER', label: 'Customer' },
  { key: 'BUSINESS', label: 'Business' },
  { key: 'SCHEDULED', label: 'Scheduled' },
];

/**
 * How far ahead a collection may be booked.
 *
 * Two weeks is enough for any real arrangement and short enough that the
 * strip stays scannable. The server does not cap the date — it only refuses
 * the past — so this is the app being reasonable, not a rule.
 */
const PICKUP_DAYS_AHEAD = 14;

/** `2026-09-01` + `09:00:00`/`11:00:00` -> `1 Sep, 09:00–11:00`. */
function slot(date?: string | null, start?: string | null, end?: string | null): string {
  const day = date ? new Date(date) : null;
  const dayText = day && !Number.isNaN(day.getTime())
    ? day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : '';
  const window = start && end ? `${String(start).slice(0, 5)}–${String(end).slice(0, 5)}` : '';
  return [dayText, window].filter(Boolean).join(', ');
}

function when(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

/** What a Manager has chosen on one card, before it is submitted. */
interface DraftPickup {
  date: string | null;
  timeId: string | null;
}

export default function ManagerOrderRequestsScreen({ navigation, route }: any) {
  const [tab, setTab] = useState<Tab>(
    route?.params?.source === 'BUSINESS' ? 'BUSINESS' : 'CUSTOMER'
  );
  const [rows, setRows] = useState<PendingOrderRequest[]>([]);
  const [counts, setCounts] = useState({ CUSTOMER: 0, BUSINESS: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState('');

  /*
   * THE DRAFT PICKUP, PER ORDER ID.
   *
   * Keyed by id rather than held as one selection for the screen, because
   * several cards are visible at once and a Manager part-way through
   * scheduling one must not have it changed by touching another. This is what
   * keeps one order's collection from ever reaching a different order.
   */
  const [drafts, setDrafts] = useState<Record<string, DraftPickup>>({});

  /** Which already-scheduled orders have their picker open. */
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  /*
   * The time lists, cached by date.
   *
   * Availability depends only on the DATE, never on the order, so two cards
   * scheduled for the same day share one fetch. Cleared whenever the list is
   * reloaded, so a screen left open across a slot boundary re-reads what is
   * still bookable rather than trusting a list from an hour ago.
   */
  const [timesByDate, setTimesByDate] = useState<Record<string, ManagerPickupTime[]>>({});
  const [loadingTimes, setLoadingTimes] = useState<Record<string, boolean>>({});

  /** The dates offered: today in IST, and the fortnight after it. */
  const dates = dateRange(todayIST(), PICKUP_DAYS_AHEAD);

  const load = useCallback(async () => {
    setError('');
    try {
      if (tab === 'SCHEDULED') {
        /*
         * The counts belong to the two pending tabs, and are fetched here too
         * so their badges stay right while a Manager works in this one.
         */
        const [list, tally] = await Promise.all([
          managerApi.getScheduledOrders(),
          managerApi.getOrderRequestCounts(),
        ]);
        setRows(list);
        setCounts(tally);
      } else {
        /*
         * Both the list and the counts, so the OTHER tab's badge is right too —
         * a Manager working through Customer Requests should see business ones
         * arriving without switching to look.
         */
        const [list, tally] = await Promise.all([
          managerApi.getOrderRequests(tab),
          managerApi.getOrderRequestCounts(),
        ]);
        setRows(list);
        setCounts(tally);
      }
      // A reload is also the moment to stop trusting cached availability.
      setTimesByDate({});
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load the requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab]);

  // Re-read on focus, so a booking placed while this screen was in the
  // background appears on return without anything having to push it.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  /**
   * The times bookable on a date, fetched once and remembered.
   *
   * Failure is silent and leaves the date with no times, which the picker
   * reports in place of the row — a Manager sees "no times" and can pick
   * another date, rather than an error banner over the whole screen for
   * something that only affects one card.
   */
  const ensureTimes = useCallback(async (dateKey: string) => {
    if (timesByDate[dateKey] || loadingTimes[dateKey]) return;
    setLoadingTimes((prev) => ({ ...prev, [dateKey]: true }));
    try {
      const times = await managerApi.getPickupTimes(dateKey);
      setTimesByDate((prev) => ({ ...prev, [dateKey]: times }));
    } catch {
      setTimesByDate((prev) => ({ ...prev, [dateKey]: [] }));
    } finally {
      setLoadingTimes((prev) => ({ ...prev, [dateKey]: false }));
    }
  }, [timesByDate, loadingTimes]);

  /*
   * KEEPS EVERY OPEN CARD SUPPLIED WITH TIMES.
   *
   * `load` empties the cache, so a card whose date was chosen before an
   * accept would otherwise be left waiting on a list nothing is fetching —
   * a spinner that never resolves. Re-asking for every date currently
   * selected closes that gap wherever the cache is emptied, rather than at
   * each of the places that empties it.
   *
   * It settles: `ensureTimes` returns immediately once a date is cached or in
   * flight, so the re-run this effect's own state change causes does nothing.
   */
  useEffect(() => {
    for (const draft of Object.values(drafts)) {
      if (draft.date) void ensureTimes(draft.date);
    }
  }, [drafts, ensureTimes]);

  const pickDate = useCallback((orderId: string, dateKey: string) => {
    setDrafts((prev) => ({
      ...prev,
      /*
       * The time is cleared with the date, always. A time chosen for tomorrow
       * is not necessarily bookable today, and silently carrying it over is
       * how a Manager ends up submitting a collection in the past.
       */
      [orderId]: { date: dateKey, timeId: null },
    }));
    void ensureTimes(dateKey);
  }, [ensureTimes]);

  const pickTime = useCallback((orderId: string, timeId: string) => {
    setDrafts((prev) => ({
      ...prev,
      [orderId]: { date: prev[orderId]?.date ?? null, timeId },
    }));
  }, []);

  /**
   * Accept, or reschedule — the same submission with a different verb.
   *
   * RE-READ, don't patch. The server decides what happens to the row and this
   * screen shows the consequence; removing or rewriting it from local state
   * would be the app asserting an outcome it did not witness.
   */
  const submit = useCallback(async (
    row: PendingOrderRequest,
    mode: 'ACCEPT' | 'RESCHEDULE'
  ) => {
    const draft = drafts[row.id];
    if (submitting || !draft?.date || !draft?.timeId) return;

    setSubmitting(row.id);
    setError('');
    try {
      const pickup = { pickupDate: draft.date, pickupTime: draft.timeId };
      if (mode === 'ACCEPT') await managerApi.acceptOrderRequest(row.id, pickup);
      else await managerApi.reschedulePickup(row.id, pickup);

      // The draft has become a fact; keeping it would leave a stale selection
      // sitting on a card that now shows the real thing.
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      setEditing((prev) => ({ ...prev, [row.id]: false }));
      await load();
    } catch (e: any) {
      /*
       * A 409 is the rule speaking — the order moved on between this list
       * loading and the tap — and a 400 is the pickup being refused. Both
       * carry the wording the Manager should see, and re-reading shows the
       * queue as it now is.
       */
      setError(
        e?.response?.data?.message || e.message
          || (mode === 'ACCEPT'
            ? 'That request could not be accepted.'
            : 'That pickup could not be changed.')
      );
      await load();
    } finally {
      setSubmitting(null);
    }
  }, [drafts, submitting, load]);

  const confirmAccept = (row: PendingOrderRequest) => {
    const draft = drafts[row.id];
    const times = draft?.date ? timesByDate[draft.date] ?? [] : [];
    const chosen = times.find((time) => time.id === draft?.timeId);

    // Guarded rather than assumed: the button is disabled without a full
    // selection, and this is what makes that true even if it were not.
    if (!draft?.date || !chosen) {
      setError('Choose a pickup date and time before accepting this order.');
      return;
    }

    Alert.alert(
      'Accept this order?',
      `${row.order_number}\n${row.customer_name}\n\n`
        + `Pickup: ${chosen.label} on ${draft.date}\n\n`
        + 'It will be marked Order Placed and passed to the sorter and rider teams, '
        + 'and the customer will see this pickup time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: () => submit(row, 'ACCEPT') },
      ]
    );
  };

  /** The date-and-time picker, shared by accepting and rescheduling. */
  const renderPicker = (row: PendingOrderRequest) => {
    const draft = drafts[row.id];
    const times = draft?.date ? timesByDate[draft.date] : undefined;

    return (
      <View style={{ gap: SPACING.xs, marginTop: SPACING.sm }}>
        <Text style={sa.label}>
          Pickup date <Text style={sa.required}>*</Text>
        </Text>
        <DateStrip
          dates={dates}
          selected={draft?.date ?? null}
          onSelect={(dateKey) => pickDate(row.id, dateKey)}
          label="Pickup date"
        />

        <Text style={[sa.label, { marginTop: SPACING.xs }]}>
          Pickup time <Text style={sa.required}>*</Text>
        </Text>
        {!draft?.date ? (
          <Text style={sa.tdMuted}>Choose a date first.</Text>
        ) : times === undefined ? (
          <ActivityIndicator size="small" color={COLORS.Primary} />
        ) : (
          <TimeSlotRow
            slots={times}
            selectedId={draft?.timeId ?? null}
            onSelect={(timeId) => pickTime(row.id, timeId)}
            label="Pickup time"
            emptyText="No pickup times are left on this date. Please choose another date."
          />
        )}
      </View>
    );
  };

  const isScheduledTab = tab === 'SCHEDULED';

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity
          style={sa.iconBtn}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>Order Requests</Text>
      </View>

      {/* Two pending queues, and the accepted collections. Each pending tab
          carries its own waiting count. */}
      <View style={sa.tabs}>
        {TABS.map((option) => {
          const on = tab === option.key;
          const count = option.key === 'SCHEDULED'
            ? 0
            : counts[option.key as OrderRequestSource];
          return (
            <TouchableOpacity
              key={option.key}
              style={[sa.tab, on && sa.tabActive]}
              onPress={() => { setLoading(true); setTab(option.key); }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={
                option.key === 'SCHEDULED'
                  ? 'Scheduled pickups'
                  : `${option.label} requests, ${count} waiting`
              }
            >
              <Text style={[sa.tabText, on && sa.tabTextActive]}>
                {option.label}{count > 0 ? ` (${count})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={sa.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={sa.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
        >
          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          {rows.length === 0 ? (
            <Text style={sa.empty}>
              {isScheduledTab
                ? 'No accepted orders are waiting to be collected.'
                : `No ${tab === 'CUSTOMER' ? 'customer' : 'business'} orders are waiting.`}
            </Text>
          ) : (
            rows.map((row) => {
              const draft = drafts[row.id];
              const ready = !!draft?.date && !!draft?.timeId;
              const busy = submitting === row.id;
              const open = !!editing[row.id];

              return (
                <View key={row.id} style={sa.card}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                    <Text style={[sa.cardTitle, sa.flex]} numberOfLines={1}>
                      {row.customer_name}
                    </Text>
                    <Text style={sa.cardTitle}>₹{Number(row.total).toFixed(2)}</Text>
                  </View>

                  {/* The order number the Sorter and Rider will see. Same row. */}
                  <Text style={sa.cardMeta} numberOfLines={1}>
                    {row.order_number}
                    {/* On the Scheduled tab the two queues are mixed, so each
                        row says which it came from. */}
                    {isScheduledTab ? ` · ${row.source === 'BUSINESS' ? 'Business' : 'Customer'}` : ''}
                    {row.laundry_type ? ` · ${row.laundry_type}` : ''}
                    {row.item_count ? ` · ${row.item_count} item(s)` : ''}
                    {/* Only when the order actually has one. A "0 kg" would be
                        a claim about the laundry; nothing at all is the truth
                        when no item in it carries a weight. */}
                    {row.total_weight_kg ? ` · ${Number(row.total_weight_kg).toFixed(2)} kg` : ''}
                  </Text>

                  {/* What the customer or business asked for when booking.
                      Shown as CONTEXT for the Manager's own choice, and only
                      on the pending tabs — once a collection is assigned, the
                      assignment is what matters and a second time beside it
                      would only invite confusion. */}
                  {!isScheduledTab
                    && !!slot(row.pickup_date, row.pickup_slot_start, row.pickup_slot_end) && (
                    <Text style={sa.cardLine}>
                      Requested: {slot(row.pickup_date, row.pickup_slot_start, row.pickup_slot_end)}
                    </Text>
                  )}
                  {!!row.customer_contact && (
                    <Text style={sa.cardLine}>Contact: {row.customer_contact}</Text>
                  )}
                  {!!row.special_notes && (
                    <Text style={sa.cardLine} numberOfLines={3}>Notes: {row.special_notes}</Text>
                  )}
                  <Text style={sa.tdMuted}>Booked {when(row.created_at)}</Text>

                  {isScheduledTab ? (
                    <>
                      {/* The assigned collection, rendered by the SAME
                          component the customer and the business see, so a
                          Manager is looking at exactly what they are. */}
                      <PickupScheduleCard
                        date={row.assigned_pickup_date}
                        time={row.assigned_pickup_time}
                        title="Pickup Scheduled"
                        variant="plain"
                      />

                      {open ? (
                        <>
                          {renderPicker(row)}
                          <View style={sa.rowBtns}>
                            <TouchableOpacity
                              style={[sa.buttonGhost, sa.flex]}
                              onPress={() => setEditing((prev) => ({ ...prev, [row.id]: false }))}
                              disabled={busy}
                              accessibilityRole="button"
                              accessibilityLabel="Cancel changing the pickup"
                            >
                              <Text style={sa.buttonGhostText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[sa.button, sa.flex, (!ready || busy) && sa.buttonDisabled]}
                              onPress={() => submit(row, 'RESCHEDULE')}
                              disabled={!ready || submitting !== null}
                              accessibilityRole="button"
                              accessibilityLabel={`Save the new pickup for order ${row.order_number}`}
                              accessibilityState={{ disabled: !ready || submitting !== null }}
                            >
                              {busy ? (
                                <ActivityIndicator color={COLORS.Surface} />
                              ) : (
                                <Text style={sa.buttonText}>Save pickup</Text>
                              )}
                            </TouchableOpacity>
                          </View>
                        </>
                      ) : (
                        <TouchableOpacity
                          style={[sa.buttonGhost, { marginTop: SPACING.sm }]}
                          onPress={() => setEditing((prev) => ({ ...prev, [row.id]: true }))}
                          disabled={submitting !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Change the pickup for order ${row.order_number}`}
                        >
                          <Text style={sa.buttonGhostText}>Change pickup</Text>
                        </TouchableOpacity>
                      )}
                    </>
                  ) : (
                    <>
                      {renderPicker(row)}

                      {/* Says WHY the button is not available yet, rather than
                          leaving a dimmed control with no explanation. */}
                      {!ready && (
                        <Text style={[sa.tdMuted, { marginTop: SPACING.xs }]}>
                          Choose a pickup date and time to accept this order.
                        </Text>
                      )}

                      <TouchableOpacity
                        style={[
                          sa.button,
                          { marginTop: SPACING.sm },
                          (!ready || busy) && sa.buttonDisabled,
                        ]}
                        onPress={() => confirmAccept(row)}
                        disabled={!ready || submitting !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`Accept order ${row.order_number}`}
                        accessibilityState={{ disabled: !ready || submitting !== null }}
                      >
                        {busy ? (
                          <ActivityIndicator color={COLORS.Surface} />
                        ) : (
                          <Text style={sa.buttonText}>Accept</Text>
                        )}
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              );
            })
          )}

          <Text
            style={{
              fontFamily: TYPOGRAPHY.fontFamily,
              fontSize: TYPOGRAPHY.sizes.xs,
              color: COLORS.TextSecondary,
              marginTop: SPACING.md,
              lineHeight: 18,
            }}
          >
            {isScheduledTab
              ? 'Changing a pickup moves only the collection — the order keeps its '
                + 'status and its place in the flow. The customer and the business '
                + 'both see the new time.'
              : 'Accepting marks the order Order Placed and records the pickup you '
                + 'choose. It is the same order throughout — the sorter and rider '
                + 'teams see the number shown above.'}
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
