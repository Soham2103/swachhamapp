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
 * MARK DEFECTIVE PIECES
 *
 * One line of one order. The Sorter types how many pieces are damaged and the
 * final quantity is shown; that is the whole form.
 *
 * NO MONEY APPEARS HERE, and not because it is hidden — the Sorter endpoints
 * do not send any. No unit price, no line amount, no order total, no invoice
 * or payment figure reaches this screen, so there is nothing to conceal in
 * the markup and nothing to find in a network tab.
 *
 * The billing is unaffected by that: the server still recomputes the line
 * amount, the order subtotal and total, and the payment position, from the
 * order's own price snapshot, inside the same transaction that stores the
 * quantity. The shop floor's job is pieces; what those pieces are worth is a
 * billing question with no decision here resting on it.
 *
 * The final quantity below is plain subtraction the Sorter can check at a
 * glance. The server recomputes it too and its answer is what gets stored.
 */

export default function MarkDefectiveModal({
  visible,
  item,
  orderNumber,
  saving,
  onCancel,
  onSave,
}: {
  visible: boolean;
  /** Null while closing, so the modal can animate out without flashing empty. */
  item: SorterOrderItem | null;
  orderNumber: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (defectiveQuantity: number, reason: string) => void;
}) {
  // Seeded from what the line already carries, so opening the form on an
  // adjusted line offers the CURRENT figure to correct rather than a blank
  // box that reads as "none recorded".
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const ordered = item ? item.original_quantity : 0;

  // Re-seed whenever a different line is opened.
  const seedKey = item ? `${item.id}:${item.defective_quantity}` : '';
  const [lastSeed, setLastSeed] = useState('');
  if (visible && seedKey && seedKey !== lastSeed) {
    setLastSeed(seedKey);
    setText(String(item!.defective_quantity || 0));
    setReason('');
    setTouched(false);
  }

  /**
   * The same rules the server enforces, so the Sorter is told at the keyboard
   * rather than by a failed request. The server checks them again regardless
   * — this is a convenience, never the guard.
   */
  const validation = useMemo(() => {
    const raw = text.trim();
    if (raw === '') return { error: 'Enter how many pieces are defective.', value: null };
    if (!/^\d+$/.test(raw)) {
      // Rejected rather than rounded: a garment is a physical object, and
      // silently turning 2.5 into 2 would bill a figure nobody asked for.
      return { error: 'Whole pieces only — no decimals or negative numbers.', value: null };
    }
    const value = Number(raw);
    if (value > ordered) {
      return { error: `Cannot be more than the ${ordered} piece(s) ordered.`, value: null };
    }
    return { error: null as string | null, value };
  }, [text, ordered]);

  const defective = validation.value ?? 0;
  const finalQuantity = Math.max(0, ordered - defective);

  const showError = touched && validation.error;
  const canSave = !saving && validation.error === null;

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
              <Ionicons name="alert-circle-outline" size={20} color={COLORS.Error} />
              <Text style={styles.title}>Mark Defective Pieces</Text>
            </View>
            <Text style={styles.orderLine}>{orderNumber}</Text>

            <Text style={styles.label}>ITEM</Text>
            <Text style={styles.itemName}>{item?.item_name || '—'}</Text>

            <Text style={styles.label}>ORDERED QUANTITY</Text>
            <View style={styles.readOnly}>
              <Text style={styles.readOnlyText}>{ordered}</Text>
            </View>

            <Text style={styles.label}>DEFECTIVE QUANTITY</Text>
            <TextInput
              style={[styles.input, showError ? styles.inputError : null]}
              value={text}
              onChangeText={(next) => {
                setTouched(true);
                setText(next);
              }}
              onBlur={() => setTouched(true)}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={COLORS.TextSecondary}
              editable={!saving}
              accessibilityLabel="Defective quantity"
            />
            {showError ? <Text style={styles.error}>{validation.error}</Text> : null}

            <Text style={styles.label}>REASON (OPTIONAL)</Text>
            <TextInput
              style={[styles.input, styles.reasonInput]}
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. Torn, stained, colour run"
              placeholderTextColor={COLORS.TextSecondary}
              multiline
              maxLength={500}
              editable={!saving}
              accessibilityLabel="Reason"
            />

            {/* WHAT THIS WILL DO — in pieces. No amount, by design; see the
                note at the top of this file. */}
            <View style={styles.preview}>
              <PreviewRow label="Final Quantity" value={String(finalQuantity)} strong />
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
                style={[styles.button, styles.save, !canSave && styles.buttonDisabled]}
                onPress={() => {
                  setTouched(true);
                  if (validation.value === null) return;
                  onSave(validation.value, reason.trim());
                }}
                disabled={!canSave}
                accessibilityRole="button"
              >
                {saving ? (
                  <ActivityIndicator size="small" color={COLORS.Surface} />
                ) : (
                  <Text style={styles.saveText}>SAVE ADJUSTMENT</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PreviewRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewLabel}>{label}</Text>
      <Text style={[styles.previewValue, strong && styles.previewValueStrong]}>{value}</Text>
    </View>
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
  label: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: COLORS.TextSecondary,
    marginTop: SPACING.md,
    marginBottom: SPACING.xs,
  },
  itemName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  readOnly: {
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  readOnlyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
    backgroundColor: COLORS.Surface,
  },
  inputError: { borderColor: COLORS.Error },
  reasonInput: { minHeight: 70, textAlignVertical: 'top' },
  error: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    marginTop: SPACING.xs,
  },
  preview: {
    marginTop: SPACING.lg,
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  previewLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  previewValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  previewValueStrong: { fontWeight: '700', fontSize: TYPOGRAPHY.sizes.base },
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
