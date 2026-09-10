import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import ticketApi, {
  TicketCategory, TicketPriority, TicketMeta, TicketWindow, PRIORITY_LABELS,
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
 * THE 48-HOUR WINDOW IS SHOWN, NOT GUESSED. When the form is opened against an
 * order, `window` reports the recorded delivery time, the deadline and what may
 * still be raised. An expired category is disabled with the reason on screen
 * rather than offered and refused — but the refusal is the server's, and it
 * still happens if this screen is wrong.
 *
 * Opened from the ticket list, or from an order screen with `orderId` and
 * `orderNumber` already known.
 */
export default function CreateTicketScreen({ navigation, route }: any) {
  const { orderId = null, orderNumber = null } = route.params || {};

  const [meta, setMeta] = useState<TicketMeta | null>(null);
  const [window, setWindow] = useState<TicketWindow | null>(null);
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
      if (orderId) {
        const w = await ticketApi.window(String(orderId));
        setWindow(w.data);
      }
    } catch (e: any) {
      setError(extractErrorMessage(e, 'Could not open the ticket form'));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  /**
   * Is this category still allowed for this order?
   *
   * Only the three delivery-related categories can expire, and only when an
   * order is in play — `window.allowed_categories` already has that worked out
   * on the server, so this asks it rather than repeating the rule.
   */
  const isAllowed = (value: TicketCategory) =>
    !window || !orderId ? true : window.allowed_categories.includes(value);

  const submit = async () => {
    if (busy) return;
    if (!category) { setError('Choose a ticket type.'); return; }
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
        order_id: orderId ? String(orderId) : null,
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

          {orderNumber ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>About order</Text>
              <Text style={styles.orderNumber}>{orderNumber}</Text>
              {window?.delivered_at ? (
                <Text style={window.expired ? styles.windowClosed : styles.windowOpen}>
                  {window.expired
                    ? 'The 48-hour window closed on ' +
                      new Date(window.deadline!).toLocaleString('en-IN') +
                      '. Quality Issue, Missing Item and Rewash Request can no longer be raised for this order.'
                    : `${window.hours_remaining} hour(s) left to raise a Quality Issue, ` +
                      'Missing Item or Rewash Request for this order.'}
                </Text>
              ) : (
                <Text style={styles.meta}>
                  This order has no recorded delivery yet, so the 48-hour window has not started.
                </Text>
              )}
            </View>
          ) : null}

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
                    allowed ? c.label : `${c.label}, unavailable — the 48-hour window has closed`
                  }
                >
                  <Ionicons
                    name={on ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={allowed ? COLORS.Primary : COLORS.TextSecondary}
                  />
                  <Text style={[styles.optionText, on && styles.optionTextOn]}>{c.label}</Text>
                  {!allowed ? <Text style={styles.meta}>window closed</Text> : null}
                </TouchableOpacity>
              );
            })}
            {(meta?.categories || []).length === 0 ? (
              <Text style={styles.meta}>Your role does not raise tickets.</Text>
            ) : null}
          </View>

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
