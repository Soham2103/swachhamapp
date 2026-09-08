import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../constants/theme';
import { formatAssignedPickup } from '../utils/istDates';

/**
 * THE COLLECTION A MANAGER ASSIGNED, shown the same way everywhere.
 *
 * One component for the customer's tracker and for both business order
 * screens, because the requirement is that those sides never disagree — and
 * three separate renderings of the same two columns is exactly how they would
 * come to. They read the same fields from the same order; this is what makes
 * them also READ THE SAME.
 *
 * IT RENDERS NOTHING UNTIL A PICKUP HAS BEEN ASSIGNED. `formatAssignedPickup`
 * returns null unless both halves are present, and null is returned straight
 * through — so an order still waiting on a Manager, and every order placed
 * before this existed, shows no heading, no empty row and no placeholder
 * dash. Absence is the honest display of "not arranged yet".
 *
 * The date and time are separate lines rather than one sentence: they are the
 * two things a customer needs to act on, and a person scanning the screen for
 * "when" should not have to read a sentence to find it.
 */

interface Props {
  /** YYYY-MM-DD from `orders.assigned_pickup_date`, or null. */
  date: string | null | undefined;
  /** HH:MM:SS from `orders.assigned_pickup_time`, or null. */
  time: string | null | undefined;
  /**
   * Heading above the two rows. Defaults to the customer-facing wording;
   * a screen that already sits under an "Order Details" heading can pass a
   * quieter one rather than repeating itself.
   */
  title?: string;
  /**
   * `card` (default) stands on its own with a border, for a screen that
   * stacks cards. `plain` drops the border and padding for a screen that is
   * already inside one.
   */
  variant?: 'card' | 'plain';
}

export default function PickupScheduleCard({
  date,
  time,
  title = 'Pickup Scheduled',
  variant = 'card',
}: Props) {
  const pickup = formatAssignedPickup(date, time);
  if (!pickup) return null;

  return (
    <View
      style={[styles.container, variant === 'card' ? styles.card : styles.plain]}
      accessible
      /* Read as one thing, so a screen reader announces the whole
         appointment instead of three disconnected fragments. */
      accessibilityLabel={`${title}. Pickup date ${pickup.date}. Pickup time ${pickup.time}.`}
    >
      <View style={styles.titleRow}>
        <Ionicons name="checkmark-circle" size={18} color={COLORS.Primary} />
        <Text style={styles.title}>{title}</Text>
      </View>

      <View style={styles.row}>
        <Ionicons name="calendar-outline" size={16} color={COLORS.TextSecondary} />
        <Text style={styles.label}>Pickup Date</Text>
        <Text style={styles.value} numberOfLines={1}>{pickup.date}</Text>
      </View>

      <View style={styles.row}>
        <Ionicons name="time-outline" size={16} color={COLORS.TextSecondary} />
        <Text style={styles.label}>Pickup Time</Text>
        <Text style={styles.value} numberOfLines={1}>{pickup.time}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.xs },
  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    // The accent border the tracker already uses for the card that matters
    // most on the screen. This is that card once a collection exists.
    borderColor: COLORS.Primary,
    padding: SPACING.md,
  },
  plain: { paddingVertical: SPACING.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    // Wraps to a second line rather than truncating the date on a narrow
    // phone: the value is the whole point of the row.
    flexWrap: 'wrap',
  },
  label: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 80,
  },
  value: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    textAlign: 'right',
    flexShrink: 1,
  },
});
