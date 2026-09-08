import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import CancelOrderModal from '../../components/business/CancelOrderModal';
import PickupScheduleCard from '../../components/PickupScheduleCard';
import businessOrderApi, { BusinessOrderTracking } from '../../services/businessOrderApi';
import { extractErrorMessage } from '../../services/api';
import { DEMO_MODE } from '../../demo/demoMode';
import { advanceDemoOrderStatus, isDemoStatusFinal } from '../../demo/demoBusinessOrderApi';

function formatWhen(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function BusinessOrderTrackingScreen({ navigation, route }: any) {
  const { orderId, orderNumber } = route.params || {};
  const [tracking, setTracking] = useState<BusinessOrderTracking | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCancelModalVisible, setIsCancelModalVisible] = useState(false);
  const [cancelError, setCancelError] = useState('');
  /** Demo builds only; always false in a production build. */
  const [isSimulating, setIsSimulating] = useState(false);

  const load = useCallback(
    async (refreshing = false) => {
      try {
        setError('');
        if (refreshing) setIsRefreshing(true);
        const response = await businessOrderApi.getOrderTracking(String(orderId));
        setTracking(response.data);
      } catch (err: any) {
        setError(extractErrorMessage(err, 'Failed to load tracking'));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [orderId]
  );

  useEffect(() => {
    load();
  }, [load]);

  /**
   * SIMULATE NEXT STATUS — demo builds only.
   *
   * A presentation aid. A real order moves because a Sorter scans it and a
   * rider collects it, none of which exists in a demo, so this steps the
   * order one place along the SAME status flow the database uses and reloads
   * the tracker. Nothing about it is a shortcut into anyone else's app: it
   * writes one field in the demo's own file on this phone.
   *
   * It is deliberately at the BOTTOM of the page, in a plain outlined button
   * marked "Demo", so it reads as part of the demonstration rather than as a
   * staff control the hotel has been given by mistake.
   */
  const handleSimulateNext = async () => {
    if (isSimulating) return;
    try {
      setIsSimulating(true);
      setError('');
      await advanceDemoOrderStatus(String(orderId));
      await load();
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not update the demo status'));
    } finally {
      setIsSimulating(false);
    }
  };

  /**
   * The button is hidden once the backend says cancellation is closed, but the
   * backend is the authority — it rejects late cancellations regardless.
   */
  const handleConfirmCancel = async (reason: string) => {
    if (isCancelling) return;
    try {
      setIsCancelling(true);
      setCancelError('');
      setError('');
      await businessOrderApi.cancelOrder(String(orderId), reason);
      setIsCancelModalVisible(false);
      await load();
    } catch (err: any) {
      setCancelError(extractErrorMessage(err, 'Failed to cancel order'));
      await load();
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BusinessHeader
        title="Track Order"
        subtitle={orderNumber || tracking?.order_number}
        onBack={() => navigation.goBack()}
      />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : error && !tracking ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={44} color={COLORS.Error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => load()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : tracking ? (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => load(true)}
              tintColor={COLORS.Primary}
            />
          }
        >
          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>Current Status</Text>
            <Text style={styles.statusValue}>{(tracking.status || '').replace(/_/g, ' ')}</Text>
          </View>

          {tracking.is_cancelled ? (
            <View style={styles.cancelledBox}>
              <Ionicons name="close-circle-outline" size={18} color={COLORS.Error} />
              <Text style={styles.cancelledText}>This order was cancelled.</Text>
            </View>
          ) : null}

          {/*
            THE COLLECTION A MANAGER ASSIGNED — the same component, the same
            two fields and therefore the same wording the customer sees.

            Under the status, because "when are you collecting" is what a
            business opens this screen for. Suppressed on a cancelled order:
            nothing is being collected, and the line above has just said so.
            Renders nothing until a pickup has actually been assigned.
          */}
          {!tracking.is_cancelled && (
            <PickupScheduleCard
              date={tracking.assigned_pickup_date}
              time={tracking.assigned_pickup_time}
            />
          )}

          <View style={styles.card}>
            {tracking.stages.map((stage, index) => {
              const isLast = index === tracking.stages.length - 1;
              const done = stage.completed || stage.current;
              return (
                <View key={stage.key} style={styles.stageRow}>
                  <View style={styles.stageIndicator}>
                    <View
                      style={[
                        styles.dot,
                        stage.completed && styles.dotCompleted,
                        stage.current && styles.dotCurrent,
                      ]}
                    >
                      {stage.completed ? (
                        <Ionicons name="checkmark" size={13} color={COLORS.Surface} />
                      ) : stage.current ? (
                        <View style={styles.dotInner} />
                      ) : null}
                    </View>
                    {!isLast ? (
                      <View style={[styles.connector, stage.completed && styles.connectorDone]} />
                    ) : null}
                  </View>

                  <View style={styles.stageText}>
                    <Text style={[styles.stageLabel, done && styles.stageLabelActive]}>
                      {stage.label}
                    </Text>
                    {stage.at ? <Text style={styles.stageTime}>{formatWhen(stage.at)}</Text> : null}
                  </View>
                </View>
              );
            })}
          </View>

          {tracking.can_cancel ? (
            <TouchableOpacity
              style={[styles.cancelButton, isCancelling && styles.cancelButtonDisabled]}
              onPress={() => {
                setCancelError('');
                setIsCancelModalVisible(true);
              }}
              disabled={isCancelling}
              activeOpacity={0.85}
            >
              <Ionicons name="close-circle-outline" size={20} color={COLORS.Error} />
              <Text style={styles.cancelButtonText}>Cancel Order</Text>
            </TouchableOpacity>
          ) : null}

          {/* Demo builds only — see `handleSimulateNext`. Hidden once the
              order has reached the end of the flow or was cancelled, so the
              button is never offered with nothing to do. */}
          {DEMO_MODE && !isDemoStatusFinal(tracking.status) ? (
            <TouchableOpacity
              style={[styles.simulateButton, isSimulating && styles.simulateButtonDisabled]}
              onPress={handleSimulateNext}
              disabled={isSimulating}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Simulate the next order status"
            >
              {isSimulating ? (
                <ActivityIndicator size="small" color={COLORS.Primary} />
              ) : (
                <Ionicons name="play-forward-outline" size={18} color={COLORS.Primary} />
              )}
              <Text style={styles.simulateButtonText}>Simulate Next Status</Text>
              <Text style={styles.simulateButtonTag}>DEMO</Text>
            </TouchableOpacity>
          ) : null}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {tracking.history.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>History</Text>
              {tracking.history.map((entry, index) => (
                <View key={`${entry.status}-${index}`} style={styles.historyRow}>
                  <Text style={styles.historyStatus}>{entry.status.replace(/_/g, ' ')}</Text>
                  <Text style={styles.historyTime}>{formatWhen(entry.created_at)}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      <CancelOrderModal
        visible={isCancelModalVisible}
        isCancelling={isCancelling}
        error={cancelError}
        onConfirm={handleConfirmCancel}
        onDismiss={() => {
          if (isCancelling) return;
          setIsCancelModalVisible(false);
          setCancelError('');
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  statusCard: {
    backgroundColor: COLORS.Primary,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
  },
  statusLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Surface,
    opacity: 0.85,
  },
  statusValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.Surface,
    textTransform: 'capitalize',
    marginTop: 2,
  },
  cancelledBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.Error + '15',
    borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm,
    marginBottom: SPACING.md,
  },
  cancelledText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.Error },
  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.sm,
  },
  stageRow: { flexDirection: 'row', gap: SPACING.md },
  stageIndicator: { alignItems: 'center', width: 26 },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotCompleted: { backgroundColor: COLORS.Primary, borderColor: COLORS.Primary },
  dotCurrent: { borderColor: COLORS.Primary, borderWidth: 3 },
  dotInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.Primary },
  connector: { width: 2, flex: 1, minHeight: 26, backgroundColor: COLORS.Border, marginVertical: 2 },
  connectorDone: { backgroundColor: COLORS.Primary },
  stageText: { flex: 1, paddingBottom: SPACING.lg },
  stageLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
  },
  stageLabelActive: { color: COLORS.TextPrimary, fontWeight: '700' },
  stageTime: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },
  historyStatus: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
    textTransform: 'capitalize',
  },
  historyTime: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.Error,
    textAlign: 'center',
  },
  cancelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 52,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 2,
    borderColor: COLORS.Error,
    marginBottom: SPACING.md,
  },
  cancelButtonDisabled: { opacity: 0.6 },
  /* Demo builds only. Deliberately quieter than Cancel Order: a thin border
     in the app's own green, and a small DEMO tag so nobody reads it as a
     staff control. */
  simulateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 48,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 1,
    borderColor: COLORS.Primary,
    marginBottom: SPACING.md,
  },
  simulateButtonDisabled: { opacity: 0.6 },
  simulateButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.Primary,
  },
  simulateButtonTag: {
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: '700',
    color: COLORS.TextSecondary,
  },
  cancelButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Error,
  },
  retryButton: {
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: { color: COLORS.Surface, fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '600' },
});
