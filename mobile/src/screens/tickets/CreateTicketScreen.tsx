import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import ticketApi, {
  TicketCategory, TicketPriority, TicketMeta, TicketOrderRef, PRIORITY_LABELS,
} from '../../services/ticketApi';
import { extractErrorMessage } from '../../services/api';

/**
 * RAISING A TICKET.
 *
 * THE CATEGORIES COME FROM THE SERVER, not from a list written here. `meta`
 * returns exactly what this caller's role may raise, so a Sorter sees its three
 * and a hotel sees its four, and adding a category anywhere means changing the
 * service and nothing else.
 *
 * THE DELIVERED ORDER IS CHOSEN, NOT TYPED. Quality Issue, Missing Item and
 * Rewash Request are about what arrived, so each must name the delivery it is
 * about. The picker lists only orders the server says are eligible — delivered
 * to this establishment and still inside the 48 hours — so an undelivered
 * order and an expired one are both simply absent rather than offered and
 * refused. The server checks it again on submit regardless.
 *
 * THE PICKER SHOWS THE REFERENCE AND NOTHING ELSE: the order number, when it
 * was delivered, and how long is left. No items, amounts or status — a ticket
 * form is not a way to read an order back.
 *
 * INVOICE ISSUE IS DIFFERENT, deliberately. An invoice covers a billing period
 * rather than one delivery, so it needs no order and has no deadline; it stays
 * available even when nothing is inside the window.
 *
 * Opened from the ticket list, or from an order screen with `orderId` and
 * `orderNumber` already known.
 */
export default function CreateTicketScreen({ navigation, route }: any) {
  const { orderId = null, orderNumber = null } = route.params || {};

  const [meta, setMeta] = useState<TicketMeta | null>(null);
  /** The delivered orders still inside the window. Empty for non-hotel roles. */
  const [orders, setOrders] = useState<TicketOrderRef[]>([]);
  /** Which of them this ticket is about. Pre-selected when opened from one. */
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(
    orderId ? String(orderId) : null
  );
  const [category, setCategory] = useState<TicketCategory | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('MEDIUM');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const m = await ticketApi.meta();
      setMeta(m.data);
      /*
       * Only a hotel picks an order. The endpoint returns an empty list for
       * every other role, so this is asked for unconditionally and simply
       * comes back empty for a Sorter or a Manager.
       */
      const list = await ticketApi.eligibleOrders();
      setOrders(list.data);
    } catch (e: any) {
      setError(extractErrorMessage(e, 'Could not open the ticket form'));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  /** True when this category must name a delivered order. From the server. */
  const needsOrder = (value: TicketCategory) =>
    (meta?.categories_needing_order || []).includes(value);

  /**
   * Is this category offerable at all right now?
   *
   * A category that needs an order is unavailable when nothing is inside the
   * window — there is no delivery left to complain about. Invoice Issue never
   * needs one and is therefore always offerable.
   */
  const isAllowed = (value: TicketCategory) => !needsOrder(value) || orders.length > 0;

  /** The chosen order, for the confirmation line under the picker. */
  const selectedOrder = orders.find((o) => o.order_id === selectedOrderId) || null;

  const submit = async () => {
    if (busy) return;
    if (!category) { setError('Choose a ticket type.'); return; }
    // The order is required for the three delivery categories and refused by
    // the server without one, so it is asked for here first.
    if (needsOrder(category) && !selectedOrderId) {
      setError('Choose the delivered order this ticket is about.');
      return;
    }
    if (!title.trim()) { setError('A title is required.'); return; }
    if (!description.trim()) { setError('A description is required.'); return; }

    setBusy(true);
    setError('');
    try {
      const res = await ticketApi.create({
        category,
        title: title.trim(),
        description: description.trim(),
        priority,
        // Only sent for the categories that are about a delivery. Invoice
        // Issue carries no order, which is what keeps it period-wide.
        order_id: needsOrder(category) ? selectedOrderId : null,
      });
      Alert.alert('Ticket raised', `${res.data.ticket_number} — ${res.data.title}`, [
        {
          text: 'View',
          onPress: () =>
            navigation.replace('TicketDetailScreen', { ticketId: res.data.id }),
        },
        { text: 'Done', style: 'cancel', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      // The server's message names the rule that was broken — the role/category
      // mismatch, or the closed window with its dates — so it is shown as-is.
      setError(extractErrorMessage(e, 'Could not raise the ticket'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Raise a ticket</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {!!error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Type</Text>
            {(meta?.categories || []).map((c) => {
              const allowed = isAllowed(c.value);
              const on = category === c.value;
              return (
                <TouchableOpacity
                  key={c.value}
                  style={[styles.option, on && styles.optionOn, !allowed && styles.disabled]}
                  onPress={() => allowed && setCategory(c.value)}
                  disabled={!allowed}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: !allowed }}
                  accessibilityLabel={
                    allowed
                      ? c.label
                      : `${c.label}, unavailable — no delivered order is inside the 48-hour window`
                  }
                >
                  <Ionicons
                    name={on ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={allowed ? COLORS.Primary : COLORS.TextSecondary}
                  />
                  <Text style={[styles.optionText, on && styles.optionTextOn]}>{c.label}</Text>
                  {!allowed ? <Text style={styles.meta}>no order in window</Text> : null}
                </TouchableOpacity>
              );
            })}
            {(meta?.categories || []).length === 0 ? (
              <Text style={styles.meta}>Your role does not raise tickets.</Text>
            ) : null}
          </View>

          {/* THE DELIVERED ORDER. Shown only for the categories that are about
              a delivery, and only the reference is listed. */}
          {category && needsOrder(category) ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Delivered order</Text>
              {orders.length === 0 ? (
                <Text style={styles.windowClosed}>
                  No delivered order is inside the 48-hour window, so this ticket type
                  cannot be raised right now.
                </Text>
              ) : (
                <>
                  {orders.map((o) => {
                    const on = selectedOrderId === o.order_id;
                    return (
                      <TouchableOpacity
                        key={o.order_id}
                        style={[styles.option, on && styles.optionOn]}
                        onPress={() => setSelectedOrderId(o.order_id)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={
                          `Order ${o.order_number}, ${o.hours_remaining} hours left`
                        }
                      >
                        <Ionicons
                          name={on ? 'radio-button-on' : 'radio-button-off'}
                          size={18}
                          color={COLORS.Primary}
                        />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[styles.optionText, on && styles.optionTextOn]}>
                            {o.order_number}
                          </Text>
                          <Text style={styles.meta}>
                            Delivered {new Date(o.delivered_at).toLocaleString('en-IN')}
                          </Text>
                        </View>
                        <Text style={styles.windowOpen}>{o.hours_remaining}h left</Text>
                      </TouchableOpacity>
                    );
                  })}
                  {selectedOrder ? (
                    <Text style={styles.meta}>
                      This ticket will be linked to {selectedOrder.order_number}.
                    </Text>
                  ) : null}
                </>
              )}
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Priority</Text>
            <View style={styles.chipRow}>
              {(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as TicketPriority[]).map((p) => (
                <TouchableOpacity
                  key={p}
                  style={[styles.chip, priority === p && styles.chipOn]}
                  onPress={() => setPriority(p)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: priority === p }}
                >
                  <Text style={[styles.chipText, priority === p && styles.chipTextOn]}>
                    {PRIORITY_LABELS[p]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Details</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="Title"
              placeholderTextColor={COLORS.TextSecondary}
              maxLength={200}
              editable={!busy}
              accessibilityLabel="Ticket title"
            />
            <TextInput
              style={[styles.input, styles.textarea]}
              value={description}
              onChangeText={setDescription}
              placeholder="Describe what happened"
              placeholderTextColor={COLORS.TextSecondary}
              multiline
              maxLength={5000}
              editable={!busy}
              accessibilityLabel="Ticket description"
            />
          </View>

          <TouchableOpacity
            style={[styles.submit, busy && styles.disabled]}
            onPress={submit}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Raise this ticket"
          >
            {busy ? (
              <ActivityIndicator size="small" color={COLORS.Surface} />
            ) : (
              <Text style={styles.submitText}>RAISE TICKET</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingHorizontal: SPACING.sm, paddingVertical: SPACING.sm,
    backgroundColor: COLORS.Surface, borderBottomWidth: 1, borderBottomColor: COLORS.Border,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold', color: COLORS.TextPrimary,
  },
  iconBtn: { padding: SPACING.xs },
  scroll: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xl },

  card: {
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, gap: SPACING.xs, ...SHADOWS.light,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold', color: COLORS.TextPrimary,
  },
  orderNumber: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800', color: COLORS.PrimaryDark,
  },
  windowOpen: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Primary, fontWeight: '600',
  },
  windowClosed: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error, fontWeight: '600', lineHeight: 19,
  },

  option: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  optionOn: { backgroundColor: '#F3F8F5' },
  optionText: {
    flex: 1, fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base, color: COLORS.TextPrimary,
  },
  optionTextOn: { fontWeight: '700', color: COLORS.PrimaryDark },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  chip: {
    paddingHorizontal: SPACING.md, paddingVertical: 8, borderRadius: BORDER_RADIUS.full,
    borderWidth: 1, borderColor: COLORS.Border, backgroundColor: COLORS.Surface,
  },
  chipOn: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  chipText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  chipTextOn: { color: COLORS.Surface },

  input: {
    borderWidth: 1, borderColor: COLORS.Border, borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm, paddingVertical: SPACING.sm,
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary, backgroundColor: COLORS.Surface,
  },
  textarea: { minHeight: 110, textAlignVertical: 'top' },

  submit: {
    height: 50, borderRadius: BORDER_RADIUS.md, backgroundColor: COLORS.Primary,
    alignItems: 'center', justifyContent: 'center',
  },
  submitText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800', color: COLORS.Surface, letterSpacing: 0.6,
  },
  disabled: { opacity: 0.5 },

  meta: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    padding: SPACING.sm, backgroundColor: '#FDECEC', borderRadius: BORDER_RADIUS.sm,
  },
  errorText: {
    flex: 1, fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.Error,
  },
});
