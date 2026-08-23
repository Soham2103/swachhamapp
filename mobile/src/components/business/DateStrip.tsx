import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { formatDayMonthIST, formatLongDateIST, relativeDayCaption } from '../../utils/istDates';

/**
 * A horizontally scrolling strip of selectable dates.
 *
 * Used by both Pickup Details and Delivery Details, so the two date pickers
 * are the same control with different ranges — the pickup strip starts at
 * today in IST, the delivery strip at the day after the chosen pickup.
 *
 * Every date it is given is selectable. Deciding WHICH dates may be offered
 * is the caller's job (via `istDates`), so this component never has to know
 * about pickup-versus-delivery rules.
 */

interface Props {
  /** YYYY-MM-DD keys, already filtered to what may be booked. */
  dates: string[];
  selected: string | null;
  onSelect: (dateKey: string) => void;
  /** Used in the accessibility label, e.g. "Pickup date". */
  label: string;
}

export default function DateStrip({ dates, selected, onSelect, label }: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      decelerationRate="fast"
    >
      {dates.map((dateKey) => {
        const isSelected = dateKey === selected;
        return (
          <TouchableOpacity
            key={dateKey}
            style={[styles.cell, isSelected && styles.cellSelected]}
            onPress={() => onSelect(dateKey)}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={`${label}: ${formatLongDateIST(dateKey)}`}
          >
            <Text style={[styles.caption, isSelected && styles.textSelected]} numberOfLines={1}>
              {relativeDayCaption(dateKey)}
            </Text>
            <Text style={[styles.date, isSelected && styles.textSelected]} numberOfLines={1}>
              {formatDayMonthIST(dateKey)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: SPACING.xs, paddingVertical: 2, paddingRight: SPACING.sm },
  cell: {
    minWidth: 72,
    height: 56,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  cellSelected: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  caption: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.TextSecondary,
  },
  date: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800',
    color: COLORS.TextPrimary,
  },
  textSelected: { color: COLORS.Surface },
});
