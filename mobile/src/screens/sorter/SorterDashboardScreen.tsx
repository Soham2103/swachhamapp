import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import sorterApi, { SorterQueue } from '../../services/sorterApi';
import { extractErrorMessage } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { formatLongDate, todayKey } from '../../utils/sorterDates';
import { STAGE_META } from './sorterStageMeta';

/**
 * Stage labels and colours live in their own module now. Re-exported here so
 * the screens that already import them from this file keep working.
 */
export { STAGE_META };

/**
 * Sorter home — the first page of the Sorter module.
 *
 * Two things only: the state of the shop floor at a glance, and the two large
 * buttons that lead to the requests page. The queue itself lives on
 * SorterRequestsScreen, which serves both buttons.
 */
export default function SorterDashboardScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();

  const [queue, setQueue] = useState<SorterQueue | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  /**
   * The counts behind the summary cards, plus how many requests today holds.
   *
   * scope=today is resolved on the server from BUSINESS_TZ_OFFSET, so an order
   * placed just after midnight IST is counted under the right business day
   * regardless of what this handset's clock says.
   */
  const load = useCallback(async () => {
    try {
      setError('');
      const response = await sorterApi.getOrders(undefined, { today: true });
      setQueue(response.data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load requests'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Reloading on focus is what brings the counts back up to date after the
  // sorter has moved an order along on the requests page.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', load);
    load();
    return unsubscribe;
  }, [navigation, load]);

  const counts = queue?.counts || { confirmed: 0, accepted: 0, ready: 0, active: 0 };
  // The server's business day when it has answered; this device's date until
  // then. Never a hardcoded date.
  const businessDate = queue?.business_date || todayKey();
  const todayCount = queue?.orders?.length ?? 0;

  const handleLogout = () => {
    Alert.alert('Log out', 'Log out of the Sorter dashboard?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => logout() },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Image
          source={require('../../../assets/swachham-logo.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.headerTitle}>Sorter Dashboard</Text>
          <Text style={styles.headerUser} numberOfLines={1}>
            {user?.name || user?.email || 'Sorter'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Ionicons name="log-out-outline" size={22} color={COLORS.Error} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => {
              setIsRefreshing(true);
              load();
            }}
            colors={[COLORS.Primary]}
            tintColor={COLORS.Primary}
          />
        }
      >
        <Text style={styles.screenTitle}>SORTER</Text>
        <Text style={styles.screenSubtitle}>Manage Requests</Text>
        <Text style={styles.todayLine}>{formatLongDate(businessDate)}</Text>

        {/* The two main buttons: full width, tall, one action each. */}
        <TouchableOpacity
          style={[styles.actionButton, styles.actionPrimary]}
          onPress={() => navigation.navigate('SorterRequestsScreen', { mode: 'today' })}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Today's Requests"
        >
          <View style={[styles.actionIcon, styles.actionIconPrimary]}>
            <Ionicons name="clipboard-outline" size={26} color={COLORS.Surface} />
          </View>
          <View style={styles.actionTextBlock}>
            <Text style={styles.actionTitlePrimary}>Today's Requests</Text>
            <Text style={styles.actionCaptionPrimary}>
              {isLoading
                ? 'Loading requests...'
                : `${todayCount} request${todayCount === 1 ? '' : 's'} today`}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={24} color={COLORS.Surface} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.actionSecondary]}
          onPress={() => navigation.navigate('SorterRequestsScreen', { mode: 'previous' })}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Previous Requests"
        >
          <View style={[styles.actionIcon, styles.actionIconSecondary]}>
            <Ionicons name="calendar-outline" size={26} color={COLORS.Primary} />
          </View>
          <View style={styles.actionTextBlock}>
            <Text style={styles.actionTitleSecondary}>Previous Requests</Text>
            <Text style={styles.actionCaptionSecondary}>Pick a date from the calendar</Text>
          </View>
          <Ionicons name="chevron-forward" size={24} color={COLORS.Primary} />
        </TouchableOpacity>

        {/* Batch processing — a THIRD button, added below the two that were
            already here. Neither of those changed: this one opens the new
            workflow and nothing else. Tapping it only opens a screen; the
            optimisation runs when START BATCH is pressed there. */}
        <TouchableOpacity
          style={[styles.actionButton, styles.actionSecondary]}
          onPress={() => navigation.navigate('SorterBatchProcessingScreen')}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Batch Processing"
        >
          <View style={[styles.actionIcon, styles.actionIconSecondary]}>
            <Ionicons name="git-branch-outline" size={26} color={COLORS.Primary} />
          </View>
          <View style={styles.actionTextBlock}>
            <Text style={styles.actionTitleSecondary}>Batch Processing</Text>
            <Text style={styles.actionCaptionSecondary}>
              Distribute approved orders across the machines
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={24} color={COLORS.Primary} />
        </TouchableOpacity>

        {error ? (
          <View style={styles.errorBlock}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                setIsLoading(true);
                load();
              }}
              activeOpacity={0.85}
            >
              <Ionicons name="refresh" size={18} color={COLORS.Surface} />
              <Text style={styles.retryText}>RETRY</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>QUEUE AT A GLANCE</Text>

        {isLoading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator size="large" color={COLORS.Primary} />
            <Text style={styles.loadingText}>Loading requests...</Text>
          </View>
        ) : (
          <>
            <View style={styles.cardRow}>
              <SummaryCard label="New" value={counts.confirmed} color={STAGE_META.confirmed.color} />
              <SummaryCard
                label="Accepted"
                value={counts.accepted}
                color={STAGE_META.accepted.color}
              />
            </View>
            <View style={styles.cardRow}>
              <SummaryCard label="Ready" value={counts.ready} color={STAGE_META.ready.color} />
              <SummaryCard label="Total Active" value={counts.active} color={COLORS.Primary} />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.summaryCard, { borderLeftColor: color }]}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.Surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  logo: {
    width: 38,
    height: 38,
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.Border,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
  },
  headerUser: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
  logoutButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Background,
  },

  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  screenTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800',
    color: COLORS.TextSecondary,
    letterSpacing: 2,
  },
  screenSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
    marginTop: 2,
  },
  todayLine: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
    marginBottom: SPACING.lg,
  },

  // ---- The two main buttons ----
  // Full width and tall, with a large icon and a caption: these are the
  // primary controls of the Sorter module and are tapped with a thumb.
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: 88,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  actionPrimary: { backgroundColor: COLORS.Primary },
  actionSecondary: {
    backgroundColor: COLORS.Surface,
    borderWidth: 2,
    borderColor: COLORS.Primary,
  },
  actionIcon: {
    width: 52,
    height: 52,
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIconPrimary: { backgroundColor: COLORS.PrimaryDark },
  actionIconSecondary: { backgroundColor: COLORS.Background },
  actionTextBlock: { flex: 1, minWidth: 0 },
  actionTitlePrimary: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800',
    color: COLORS.Surface,
  },
  actionCaptionPrimary: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Accent,
    marginTop: 2,
  },
  actionTitleSecondary: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
  },
  actionCaptionSecondary: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },

  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    letterSpacing: 1,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },

  cardRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.sm },
  summaryCard: {
    flex: 1,
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderLeftWidth: 5,
    padding: SPACING.md,
    ...SHADOWS.light,
  },
  summaryValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  summaryLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },

  loadingBlock: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  loadingText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
  },

  errorBlock: {
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#FDECEC',
  },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    textAlign: 'center',
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    minHeight: 44,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
  },
  retryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },
});
