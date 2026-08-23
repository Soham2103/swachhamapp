import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { BusinessTimeSlot } from '../../services/businessOrderApi';

/**
 * A compact, horizontally scrolling row of time slots.
 *
 * One component for both pickup and delivery, so the two can never drift
 * apart in size, spacing or behaviour, and the slot list is passed in rather
 * than hardcoded here — it comes from the server.
 *
 * SIZE. The pills are deliberately small: a single line of text, tight
 * padding, and a 40pt height that still clears the minimum comfortable touch
 * target. They sit in one row that scrolls sideways rather than wrapping, so
 * the section costs one line of vertical space no matter how many slots the
 * working day has.
 *
 * STATE. Selected is filled, not merely outlined, and unavailable pills are
 * dimmed AND non-interactive AND announced as disabled — the state never
 * rests on colour alone.
 */

interface Props {
  slots: BusinessTimeSlot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Used in the accessibility label, e.g. "Pickup time". */
  label: string;
  /** Shown in place of the row when nothing is bookable. */
  emptyText?: string;
}

export default function TimeSlotRow({
  slots,
  selectedId,
  onSelect,
  label,
  emptyText = 'No time slots left for this date. Please choose another date.',
}: Props) {
  const bookable = slots.filter((slot) => slot.available);

  if (bookable.length === 0) {
    return <Text style={styles.empty}>{emptyText}</Text>;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      /* Keeps a half-visible pill at the edge, which is what tells the user
         the row scrolls without needing a chevron. */
      decelerationRate="fast"
    >
      {slots.map((slot) => {
        const isSelected = selectedId === slot.id;
        const isDisabled = !slot.available;
        return (
          <TouchableOpacity
            key={slot.id}
            style={[
              styles.pill,
              isSelected && styles.pillSelected,
              isDisabled && styles.pillDisabled,
            ]}
            onPress={() => onSelect(slot.id)}
            disabled={isDisabled}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, disabled: isDisabled }}
            accessibilityLabel={`${label}: ${slot.label}${isDisabled ? ', unavailable' : ''}`}
          >
            <Text
              style={[
                styles.text,
                isSelected && styles.textSelected,
                isDisabled && styles.textDisabled,
              ]}
              numberOfLines={1}
            >
              {slot.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: SPACING.xs, paddingVertical: 2, paddingRight: SPACING.sm },
  pill: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm + 2,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
  },
  pillSelected: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  pillDisabled: { backgroundColor: COLORS.Background, borderColor: COLORS.Border, opacity: 0.5 },
  text: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  textSelected: { color: COLORS.Surface, fontWeight: '800' },
  textDisabled: { color: COLORS.TextSecondary },
  empty: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    paddingVertical: SPACING.sm,
  },
});
