import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  Animated,
  Easing,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../constants/theme';

/**
 * Order confirmation.
 *
 * Replaces the plain system alert with a branded panel: the Swachham delivery
 * scooter drives continuously across the panel, right to left — the way it
 * faces — over a road whose dashes scroll the other way, so it reads as a
 * delivery in motion rather than a parked bike.
 *
 * Every animation drives a transform or opacity with useNativeDriver, so the
 * whole thing runs on the UI thread and stays smooth on a mid-range phone even
 * while the order request is still settling in the background.
 */

interface Props {
  visible: boolean;
  /** e.g. SWG#20082026000001 — shown as the receipt line. */
  orderNumber: string;
  /**
   * The booked schedule, shown under the order number. Omitted when unknown.
   *
   * Pickup and delivery each carry their own date: they are separate days,
   * so showing one date above both slots would misstate the booking.
   */
  pickupDate?: string;
  pickupSlot?: string;
  deliveryDate?: string;
  deliverySlot?: string;
  /** Primary action: takes the user to their orders. */
  onViewOrders: () => void;
  /** Dismiss without navigating. */
  onClose: () => void;
}

export default function OrderConfirmationModal({
  visible,
  orderNumber,
  pickupDate,
  pickupSlot,
  deliveryDate,
  deliverySlot,
  onViewOrders,
  onClose,
}: Props) {
  const { width } = useWindowDimensions();

  // Panel entrance.
  const backdrop = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(0.9)).current;
  const badgePop = useRef(new Animated.Value(0)).current;

  // The ride: one continuous left-to-right pass, looped.
  const ride = useRef(new Animated.Value(0)).current;
  const road = useRef(new Animated.Value(0)).current;

  /** Measured so the scooter's travel matches the real panel width. */
  const [stageWidth, setStageWidth] = useState(0);

  useEffect(() => {
    if (!visible) {
      // Reset so a second order replays the whole thing from the start.
      backdrop.setValue(0);
      cardScale.setValue(0.9);
      badgePop.setValue(0);
      ride.setValue(0);
      road.setValue(0);
      return;
    }

    Animated.parallel([
      Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.spring(cardScale, { toValue: 1, damping: 14, stiffness: 180, useNativeDriver: true }),
      Animated.spring(badgePop, { toValue: 1, damping: 9, stiffness: 200, useNativeDriver: true }),
    ]).start();

    // Wait until the stage has been measured, so the scooter's travel spans
    // the real panel width instead of a guess.
    if (!stageWidth) return;

    // One continuous pass: in from the right, straight across, off the left,
    // then round again. Linear easing keeps the speed constant so the loop
    // point is not visible.
    const riding = Animated.loop(
      Animated.timing(ride, {
        toValue: 1,
        duration: RIDE_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    // The road scrolls the opposite way, which reads as ground moving under
    // the wheels rather than the scooter sliding over a static strip.
    const rolling = Animated.loop(
      Animated.timing(road, {
        toValue: 1,
        // Kept in proportion to the ride, so the ground speed still matches
        // the scooter rather than racing ahead of it.
        duration: ROAD_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    riding.start();
    rolling.start();

    return () => {
      riding.stop();
      rolling.stop();
    };
  }, [visible, stageWidth, backdrop, cardScale, badgePop, ride, road]);

  const scooterWidth = stageWidth ? stageWidth * SCOOTER_WIDTH_RATIO : width * SCOOTER_WIDTH_RATIO;

  // Right to left, matching the way the scooter faces in the artwork: it
  // enters fully off the right edge and exits past the left.
  const scooterTranslate = ride.interpolate({
    inputRange: [0, 1],
    outputRange: [stageWidth || width, -scooterWidth],
  });
  // The road runs opposite to the travel, so the ground still appears to move
  // under the wheels. One dash pitch, so the loop restarts without a jump.
  const roadTranslate = road.interpolate({ inputRange: [0, 1], outputRange: [0, DASH_PITCH] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
        <Animated.View style={[styles.card, { transform: [{ scale: cardScale }] }]}>
          {/* ---- The ride ---- */}
          <View
            style={styles.stage}
            onLayout={(e) => setStageWidth(e.nativeEvent.layout.width)}
          >
            {/* Dashes scroll right while the scooter travels left, so the
                ground appears to move under the wheels. */}
            <View style={styles.road}>
              <Animated.View
                style={[styles.dashes, { transform: [{ translateX: roadTranslate }] }]}
              >
                {Array.from({ length: DASH_COUNT }).map((_, i) => (
                  <View key={i} style={styles.dash} />
                ))}
              </Animated.View>
            </View>

            <Animated.Image
              source={require('../../assets/delivery-scooter.png')}
              style={[
                styles.scooter,
                { width: scooterWidth, transform: [{ translateX: scooterTranslate }] },
              ]}
              resizeMode="contain"
              accessibilityLabel="Swachham delivery scooter"
            />
          </View>

          {/* ---- The message ---- */}
          <Animated.View
            style={[
              styles.badge,
              {
                opacity: badgePop,
                transform: [{ scale: badgePop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
              },
            ]}
          >
            <Ionicons name="checkmark" size={30} color={COLORS.Surface} />
          </Animated.View>

          <Text style={styles.title}>Order Placed!</Text>
          <Text style={styles.subtitle}>
            Your laundry is on its way. We will collect it shortly.
          </Text>

          <View style={styles.orderChip}>
            <Ionicons name="receipt-outline" size={16} color={COLORS.PrimaryDark} />
            <Text style={styles.orderChipText} numberOfLines={1}>
              {orderNumber}
            </Text>
          </View>

          {/* What was booked, straight from the order: each leg with its own
              date above its own time. */}
          {pickupSlot || deliverySlot ? (
            <View style={styles.pickupBlock}>
              {pickupSlot || pickupDate ? (
                <>
                  <Text style={styles.pickupLabel}>Pickup</Text>
                  {pickupDate ? <Text style={styles.pickupDate}>{pickupDate}</Text> : null}
                  {pickupSlot ? <Text style={styles.pickupValue}>{pickupSlot}</Text> : null}
                </>
              ) : null}

              {deliverySlot || deliveryDate ? (
                <>
                  <Text style={styles.pickupLabel}>Delivery</Text>
                  {deliveryDate ? <Text style={styles.pickupDate}>{deliveryDate}</Text> : null}
                  {deliverySlot ? <Text style={styles.pickupValue}>{deliverySlot}</Text> : null}
                </>
              ) : null}
            </View>
          ) : null}

          <TouchableOpacity style={styles.primaryButton} onPress={onViewOrders} activeOpacity={0.85}>
            <Ionicons name="list-outline" size={20} color={COLORS.Surface} />
            <Text style={styles.primaryButtonText}>VIEW MY ORDERS</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={onClose} activeOpacity={0.85}>
            <Text style={styles.secondaryButtonText}>CLOSE</Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/** How long one full crossing takes. Higher is slower. */
const RIDE_DURATION_MS = 6000;
/** Scooter width as a share of the panel, leaving room to enter and exit. */
const SCOOTER_WIDTH_RATIO = 0.62;

/** One dash pitch of ground travel, paced to match the ride. */
const ROAD_DURATION_MS = 1600;

/** Road dash geometry — the pitch is what the scroll loop resets by. */
const DASH_WIDTH = 18;
const DASH_GAP = 14;
const DASH_PITCH = DASH_WIDTH + DASH_GAP;
const DASH_COUNT = 30;

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
  },

  card: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
    ...SHADOWS.light,
  },

  // Clips the scooter while it is still off to the left.
  stage: {
    width: '100%',
    height: 150,
    marginTop: SPACING.md,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  // Absolutely placed: translateX alone drives it, and it rides above the
  // road strip without pushing the layout around.
  scooter: {
    position: 'absolute',
    left: 0,
    bottom: 10,
    height: 120,
  },

  road: {
    height: 4,
    marginTop: SPACING.xs,
    borderRadius: 2,
    backgroundColor: COLORS.Background,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  // Offset by one pitch so the row still covers the full width at the moment
  // the loop resets, whichever way it is scrolling.
  dashes: { flexDirection: 'row', gap: DASH_GAP, marginLeft: -DASH_PITCH },
  dash: {
    width: DASH_WIDTH,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.Primary,
    opacity: 0.35,
  },

  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    marginTop: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Success,
  },

  title: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
    marginTop: SPACING.sm,
  },
  subtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    marginTop: SPACING.xs,
  },

  orderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginTop: SPACING.md,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Background,
    maxWidth: '100%',
  },
  pickupBlock: { alignItems: 'center', marginTop: SPACING.sm, gap: 2 },
  pickupLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700',
    color: COLORS.TextSecondary,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  pickupValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
  },
  pickupDate: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  orderChipText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
    flexShrink: 1,
  },

  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    alignSelf: 'stretch',
    minHeight: 56,
    marginTop: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
  },
  primaryButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },

  secondaryButton: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: SPACING.xs,
  },
  secondaryButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextSecondary,
  },
});
