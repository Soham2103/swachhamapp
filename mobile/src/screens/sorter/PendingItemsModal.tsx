import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { SorterOrderItem } from '../../services/sorterApi';

/**
 * SELECT PENDING ITEMS
 *
 * Shown after the Sorter answers "yes" to the pending question. Every line is
 * listed with its ordered quantity and a box for how many pieces of it are
 * NOT finished.
 *
 * PENDING IS A QUANTITY, NOT A TICK. This screen replaced a checkbox list,
 * and the difference is the whole point: ticking "Bedsheet" held all five,
 * when what was needed was "two stay, three go". A line left at 0 — which is
 * every line until the Sorter types otherwise — goes out in full.
 *
 * DELIVERY QUANTITY IS SHOWN, NOT ENTERED. It is `ordered - pending`, and the
 * server computes it again from the row it locks; the figure here exists so
 * the split is visible while it is being typed, and is never sent.
 *
 * NO PRICES. Like every Sorter screen, this one is sent none. Holding pieces
 * back is not a defect and moves no amount, so there is no figure here to
 * change and nothing to hide.
 */

export default function PendingItemsModal({
  visible,
  items,
  orderNumber,
  saving,
  onCancel,
  onSave,
}: {
  visible: boolean;
  items: SorterOrderItem[];
  orderNumber: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (
    pendingItems: Array<{ orderItemId: string; pendingQuantity: number }>,
    reason: string
  ) => void;
}) {
  /** What is typed, per line, as text — so a half-typed value is not clamped. */
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  /** The confirmation summary, shown before anything is saved. */
  const [confirming, setConfirming] = useState(false);

  // A fresh sheet each time it opens, seeded from what is already held so a
  // correction starts from the current figure rather than from blank.
  const seedKey = visible ? items.map((i) => `${i.id}:${i.pending_quantity}`).join(',') : '';
  const [lastSeed, setLastSeed] = useState('');
  if (visible && seedKey !== lastSeed) {
    setLastSeed(seedKey);
    const seeded: Record<string, string> = {};
    for (const item of items) seeded[item.id] = String(item.pending_quantity || 0);
    setEntered(seeded);
    setReason('');
    setTouched(false);
    setConfirming(false);
  }

  /**
   * The same rules the server enforces, so the Sorter is told at the keyboard
   * rather than by a failed request. The server checks them again against the
   * quantity it reads from the locked row — this is a convenience, never the
   * guard.
   */
  const rows = useMemo(
    () =>
      items.map((item) => {
        const raw = (entered[item.id] ?? '0').trim();
        const ordered = item.original_quantity;
        let error: string | null = null;
        let pending = 0;

        if (raw === '') pending = 0;
        else if (!/^\d+$/.test(raw)) error = 'Whole pieces only.';
        else {
          pending = Number(raw);
          if (pending > ordered) {
            error = `Pending quantity cannot be greater than ordered quantity (${ordered}).`;
          }
        }

        return {
          item,
          raw,
          pending: error ? 0 : pending,
          delivery: error ? ordered : Math.max(0, ordered - pending),
          error,
        };
      }),
    [items, entered]
  );

  const firstError = rows.find((r) => r.error)?.error ?? null;
  const totalPending = rows.reduce((sum, r) => sum + r.pending, 0);
  const totalDelivery = rows.reduce((sum, r) => sum + r.delivery, 0);
  const canContinue = !saving && !firstError;

  const goingRows = rows.filter((r) => r.delivery > 0);
  const stayingRows = rows.filter((r) => r.pending > 0);

  const save = () =>
    onSave(
      // Only the lines that actually hold something are sent. A line at 0
      // holds nothing, and the server treats an unmentioned line as holding
      // nothing, so the two agree.
      rows
        .filter((r) => r.pending > 0)
        .map((r) => ({ orderItemId: r.item.id, pendingQuantity: r.pending })),
      reason.trim()
    );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={saving ? undefined : onCancel}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
              <Ionicons
                name={confirming ? 'checkmark-circle-outline' : 'time-outline'}
                size={20}
                color={COLORS.Warning}
              />
              <Text style={styles.title}>
                {confirming ? 'Order Processing Summary' : 'Select Pending Items'}
              </Text>
            </View>
            <Text style={styles.orderLine}>{orderNumber}</Text>

            {confirming ? (
              /* ---- The split, to check before it is saved ---- */
              <>
                <Text style={styles.sectionHead}>OUT FOR DELIVERY</Text>
                {goingRows.length === 0 ? (
                  <Text style={styles.empty}>Nothing — every piece is being held.</Text>
                ) : (
                  goingRows.map((r) => (
                    <View key={r.item.id} style={styles.summaryRow}>
                      <Text style={styles.summaryName}>{r.item.item_name}</Text>
                      <Text style={styles.summaryGoing}>{r.delivery}</Text>
                    </View>
                  ))
                )}

                <Text style={styles.sectionHead}>PENDING</Text>
                {stayingRows.length === 0 ? (
                  <Text style={styles.empty}>Nothing — the whole order goes out.</Text>
                ) : (
                  stayingRows.map((r) => (
                    <View key={r.item.id} style={styles.summaryRow}>
                      <Text style={styles.summaryName}>{r.item.item_name}</Text>
                      <Text style={styles.summaryHeld}>{r.pending}</Text>
                    </View>
                  ))
                )}

                {reason ? <Text style={styles.reasonEcho}>Reason: {reason}</Text> : null}

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.button, styles.cancel]}
                    onPress={() => setConfirming(false)}
                    disabled={saving}
                    accessibilityRole="button"
                  >
                    <Text style={styles.cancelText}>BACK</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, styles.save, saving && styles.buttonDisabled]}
                    onPress={save}
                    disabled={saving}
                    accessibilityRole="button"
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color={COLORS.Surface} />
                    ) : (
                      <Text style={styles.saveText}>CONTINUE</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              /* ---- The quantity entry ---- */
              <>
                <Text style={styles.help}>
                  Enter how many pieces of each item are still being processed. Everything else
                  goes out for delivery.
                </Text>

                <View style={styles.headRow}>
                  <Text style={[styles.headCell, styles.colName]}>Item</Text>
                  <Text style={[styles.headCell, styles.colNum]}>Ordered</Text>
                  <Text style={[styles.headCell, styles.colNum]}>Pending</Text>
                  <Text style={[styles.headCell, styles.colNum]}>Going</Text>
                </View>

                {rows.map((r) => (
                  <View key={r.item.id}>
                    <View style={styles.row}>
                      <Text style={[styles.name, styles.colName]} numberOfLines={2}>
                        {r.item.item_name}
                      </Text>
                      <Text style={[styles.ordered, styles.colNum]}>
                        {r.item.original_quantity}
                      </Text>
                      <TextInput
                        style={[styles.input, styles.colNum, r.error ? styles.inputError : null]}
                        value={r.raw}
                        onChangeText={(next) => {
                          setTouched(true);
                          setEntered((current) => ({ ...current, [r.item.id]: next }));
                        }}
                        keyboardType="number-pad"
                        selectTextOnFocus
                        editable={!saving}
                        accessibilityLabel={`Pending quantity for ${r.item.item_name}`}
                      />
                      <Text
                        style={[
                          styles.going,
                          styles.colNum,
                          r.pending > 0 && styles.goingSplit,
                        ]}
                      >
                        {r.delivery}
                      </Text>
                    </View>
                    {touched && r.error ? (
                      <Text style={styles.error}>{r.error}</Text>
                    ) : null}
                  </View>
                ))}

                <Text style={styles.label}>REASON (OPTIONAL)</Text>
                <TextInput
                  style={styles.reasonInput}
                  value={reason}
                  onChangeText={setReason}
                  placeholder="e.g. Needs a second wash"
                  placeholderTextColor={COLORS.TextSecondary}
                  multiline
                  maxLength={500}
                  editable={!saving}
                  accessibilityLabel="Reason"
                />

                <View style={styles.totals}>
                  <Text style={styles.totalsText}>
                    {totalDelivery} piece(s) out for delivery · {totalPending} pending
                  </Text>
                </View>

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.button, styles.cancel]}
                    onPress={onCancel}
                    disabled={saving}
                    accessibilityRole="button"
                  >
                    <Text style={styles.cancelText}>CANCEL</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, styles.save, !canContinue && styles.buttonDisabled]}
                    onPress={() => {
                      setTouched(true);
                      if (!canContinue) return;
                      setConfirming(true);
                    }}
                    disabled={!canContinue}
                    accessibilityRole="button"
                  >
                    <Text style={styles.saveText}>CONTINUE</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: COLORS.Surface,
    borderTopLeftRadius: BORDER_RADIUS.lg,
    borderTopRightRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    maxHeight: '90%',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  orderLine: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: SPACING.xs,
  },
  help: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
    lineHeight: 20,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingBottom: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  headCell: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: COLORS.TextSecondary,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  colName: { flex: 1, minWidth: 0 },
  colNum: { width: 58, textAlign: 'center' },
  name: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  ordered: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    backgroundColor: COLORS.Surface,
  },
  inputError: { borderColor: COLORS.Error },
  going: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  /* The figure that changed because pieces are being held. */
  goingSplit: { color: '#1B4332' },
  error: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Error,
    paddingBottom: SPACING.xs,
  },
  label: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: COLORS.TextSecondary,
    marginTop: SPACING.md,
    marginBottom: SPACING.xs,
  },
  reasonInput: {
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  totals: {
    marginTop: SPACING.md,
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
  },
  totalsText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  /* ---- the confirmation summary ---- */
  sectionHead: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: COLORS.TextSecondary,
    marginTop: SPACING.lg,
    marginBottom: SPACING.xs,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  summaryName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
    flex: 1,
    minWidth: 0,
  },
  summaryGoing: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: '#1B4332',
  },
  summaryHeld: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: '#8A5200',
  },
  empty: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    fontStyle: 'italic',
  },
  reasonEcho: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: SPACING.md,
  },
  actions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.lg },
  button: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  cancel: { borderWidth: 1, borderColor: COLORS.Border },
  cancelText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontWeight: '700',
    color: COLORS.TextSecondary,
  },
  save: { backgroundColor: COLORS.Primary },
  saveText: { fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '700', color: COLORS.Surface },
});
