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

/**
 * How a defective quantity divides between the two piles.
 *
 * Always both numbers, never null: the form always knows which colour it
 * counted, and an empty box means none of that colour rather than unknown.
 */
export type DefectiveSplit = { white: number; color: number };

export default function MarkDefectiveModal({
  visible,
  item,
  orderNumber,
  saving,
  onCancel,
  onReportPiece,
  availableWhite,
  availableColour,
}: {
  visible: boolean;
  /** Null while closing, so the modal can animate out without flashing empty. */
  item: SorterOrderItem | null;
  orderNumber: string;
  saving: boolean;
  onCancel: () => void;
  /**
   * REPORT THE PIECE ITSELF — the photo, and the WhatsApp notification that
   * carries it. Reached from HERE rather than from a button of its own, so
   * the details the report is about are the ones just typed above: the same
   * line, the same count, the same reason. The parent saves the adjustment
   * first and then opens the camera.
   */
  onReportPiece: (defectiveQuantity: number, reason: string, split: DefectiveSplit) => void;
  /**
   * The cloth counted on this line, so each box can be checked against its
   * OWN pile rather than against the line total.
   *
   * NULL means that colour has not been counted, and then there is no ceiling
   * to enforce: refusing damage the Sorter can plainly see, because nobody
   * has counted yet, would stop the shop floor recording it at all. The
   * server applies the same rule.
   *
   * These arrive already NET of any defect currently recorded, so re-opening
   * the form on an adjusted line must add that figure back before checking —
   * see `availableFor` below.
   */
  availableWhite: number | null;
  availableColour: number | null;
}) {
  /*
   * TWO BOXES, ONE PER COLOUR.
   *
   * Seeded from what the line already carries so re-opening the form offers
   * the CURRENT figures to correct rather than blanks that read as "none
   * recorded". A line adjusted before the split existed has NULL for both, so
   * its whole defective quantity is seeded into WHITE — the pieces are real
   * and must not be silently dropped to zero, and white is the side that does
   * not change what colour cloth is left.
   */
  const [whiteText, setWhiteText] = useState('');
  const [colourText, setColourText] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const ordered = item ? item.original_quantity : 0;

  // Re-seed whenever a different line is opened.
  const seedKey = item
    ? `${item.id}:${item.defective_quantity}:${item.white_defective_quantity}:${item.color_defective_quantity}`
    : '';
  const [lastSeed, setLastSeed] = useState('');
  if (visible && seedKey && seedKey !== lastSeed) {
    setLastSeed(seedKey);
    const white = item!.white_defective_quantity;
    const colour = item!.color_defective_quantity;
    const hasSplit = white !== null || colour !== null;
    setWhiteText(String(hasSplit ? white || 0 : item!.defective_quantity || 0));
    setColourText(String(hasSplit ? colour || 0 : 0));
    setReason('');
    setTouched(false);
  }

  /*
   * The ceiling for each box is the count AS COUNTED.
   *
   * `availableWhite` / `availableColour` are the original figures — the
   * server stores and returns the count off the pile, with the defective
   * pieces subtracted only where they are displayed. So they are the ceiling
   * directly: a line counted at 20 white can have at most 20 white defective,
   * whatever is already recorded against it.
   *
   * That also makes a correction work without arithmetic here. An earlier
   * version received these already net of the recorded defect and had to add
   * it back before comparing, which was one more place for the two figures to
   * drift apart.
   */
  const whiteCeiling = availableWhite;
  const colourCeiling = availableColour;

  /**
   * One box's own rules. The server enforces all of these again — this is a
   * convenience so the Sorter is told at the keyboard, never the guard.
   */
  const checkBox = (raw: string, label: string, ceiling: number | null) => {
    const trimmed = raw.trim();
    // An empty box is none of that colour, not an error: a line can be all
    // white, and forcing a "0" into the colour box to say so is friction.
    if (trimmed === '') return { error: null as string | null, value: 0 };
    if (!/^\d+$/.test(trimmed)) {
      // Rejected rather than rounded: a garment is a physical object, and
      // silently turning 2.5 into 2 would bill a figure nobody asked for.
      // The pattern also rejects a leading "-", so negatives cannot be typed.
      return { error: `${label}: whole pieces only — no decimals or negatives.`, value: null };
    }
    const value = Number(trimmed);
    if (ceiling !== null && value > ceiling) {
      return {
        error: `${label}: only ${ceiling} piece(s) counted, so ${value} cannot be defective.`,
        value: null,
      };
    }
    return { error: null as string | null, value };
  };

  const validation = useMemo(() => {
    const white = checkBox(whiteText, 'White', whiteCeiling);
    if (white.error) return { error: white.error, white: null, colour: null, total: null };

    const colour = checkBox(colourText, 'Colour', colourCeiling);
    if (colour.error) return { error: colour.error, white: null, colour: null, total: null };

    const total = (white.value || 0) + (colour.value || 0);
    if (total > ordered) {
      return {
        error: `Cannot be more than the ${ordered} piece(s) ordered.`,
        white: null,
        colour: null,
        total: null,
      };
    }

    return { error: null as string | null, white: white.value, colour: colour.value, total };
  }, [whiteText, colourText, whiteCeiling, colourCeiling, ordered]);

  const defective = validation.total ?? 0;
  const finalQuantity = Math.max(0, ordered - defective);

  const showError = touched && validation.error;
  const canSave = !saving && validation.error === null;

  /** What the two boxes come to, for the parent. */
  const split: DefectiveSplit = {
    white: validation.white ?? 0,
    color: validation.colour ?? 0,
  };

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

            {/*
              * DEFECTIVE QUANTITY, SPLIT BY COLOUR.
              *
              * Two boxes because the defect has to come off the right pile:
              * white damage reduces the white count and colour damage the
              * colour count. Each box shows the pieces it may not exceed, so
              * the limit is visible before it is hit rather than after.
              */}
            <Text style={styles.label}>DEFECTIVE QUANTITY</Text>

            <Text style={styles.splitLabel}>
              White{whiteCeiling !== null ? ` (of ${whiteCeiling} counted)` : ''}
            </Text>
            <TextInput
              style={[styles.input, showError ? styles.inputError : null]}
              value={whiteText}
              onChangeText={(next) => {
                setTouched(true);
                // Digits only, dropped as typed: a minus sign or a decimal
                // point never reaches the value, so a negative cannot be
                // entered at all.
                setWhiteText(next.replace(/[^0-9]/g, ''));
              }}
              onBlur={() => setTouched(true)}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={COLORS.TextSecondary}
              editable={!saving}
              accessibilityLabel="White defective quantity"
            />

            <Text style={styles.splitLabel}>
              Colour{colourCeiling !== null ? ` (of ${colourCeiling} counted)` : ''}
            </Text>
            <TextInput
              style={[styles.input, showError ? styles.inputError : null]}
              value={colourText}
              onChangeText={(next) => {
                setTouched(true);
                setColourText(next.replace(/[^0-9]/g, ''));
              }}
              onBlur={() => setTouched(true)}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={COLORS.TextSecondary}
              editable={!saving}
              accessibilityLabel="Colour defective quantity"
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
              {/*
                SAVE ADJUSTMENT WAS REMOVED, and its handler with it.
                It recorded a defective quantity and stopped there — no photo,
                nothing sent — which was the one way to mark a piece defective
                without evidence. A defect is a claim against a customer's
                garment, so the photo is not optional and there is now exactly
                one way to record one: the button below.
              */}
            </View>

            {/* THE DEFECTIVE PIECE ITSELF. Saves the figures above, then
                opens the camera — one action, so the photo and the count it
                belongs to can never describe different things. */}
            <TouchableOpacity
              style={[styles.reportButton, !canSave && styles.buttonDisabled]}
              onPress={() => {
                setTouched(true);
                if (validation.total === null) return;
                onReportPiece(validation.total, reason.trim(), split);
              }}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel="Report the defective piece with a photo"
            >
              <Ionicons name="camera" size={18} color={COLORS.Primary} />
              <Text style={styles.reportText}>REPORT DEFECTIVE PIECE (PHOTO)</Text>
            </TouchableOpacity>
            <Text style={styles.reportHint}>
              Saves the figures above, then takes the photo and sends the report to the
              customer and the sorting desk on WhatsApp. The photo is required.
            </Text>
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
  /**
   * The per-colour caption above each box. Lighter than `label`, and with a
   * smaller top margin, so the two boxes read as one DEFECTIVE QUANTITY
   * section rather than as two unrelated fields.
   */
  splitLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.TextPrimary,
    marginTop: SPACING.sm,
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
  reportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 2,
    borderColor: COLORS.Primary,
    backgroundColor: COLORS.Surface,
  },
  reportText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.Primary,
    letterSpacing: 0.5,
  },
  reportHint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: SPACING.xs,
    marginBottom: SPACING.sm,
  },
});
