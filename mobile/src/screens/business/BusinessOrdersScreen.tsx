import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigationState } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import businessOrderApi, { BusinessOrderSummary } from '../../services/businessOrderApi';
import businessDoorApi from '../../services/businessDoorApi';
import { extractErrorMessage } from '../../services/api';

/**
 * The three views of the order list.
 *
 * Filtered here rather than by another request: the list the API already
 * returns carries each order's status, so switching views costs nothing and
 * works offline of a refresh.
 *
 * `statuses` lists the pipeline statuses this project already uses. All Orders
 * has none, which means everything — including cancelled orders, which belong
 * to neither of the other two.
 */
type OrderFilter = 'all' | 'in_progress' | 'delivered';

const ORDER_FILTERS: Array<{ key: OrderFilter; label: string; statuses: string[] }> = [
  { key: 'all', label: 'All Orders', statuses: [] },
  {
    key: 'in_progress',
    label: 'In Progress',
    statuses: [
      'ORDER_PLACED',
      'RECEIVED_AT_FACILITY',
      'IN_PROCESS',
      'READY_FOR_DELIVERY',
      'OUT_FOR_DELIVERY',
    ],
  },
  { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED', 'COMPLETED'] },
];

const LAUNDRY_LABEL: Record<string, string> = { hotel: 'Hotel Laundry', guest: 'Guest Laundry' };
const ORDER_LABEL: Record<string, string> = { standard: 'Standard Order', quick: 'Quick Order' };
/* Wash & Fold is the TOWEL service; without it here a towel line on a past
   order printed the bare code `wash_fold`. */
const SERVICE_LABEL: Record<string, string> = {
  wash_fold: 'Wash & Fold',
  wash_iron: 'Wash & Iron',
  dry_clean: 'Dry Clean',
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function BusinessOrdersScreen({ navigation }: any) {
  /**
   * Whether THIS screen's own stack has somewhere to pop to.
   *
   * `navigation.canGoBack()` is not the test: from a tab's first page it can
   * still report true because the tab navigator itself sits inside a parent
   * stack, which would put a Back button on a root page that then left the
   * Business section. The index of the nearest navigator's own state answers
   * the question actually being asked — 0 means this is the first page.
   */
  const canGoBack = useNavigationState((state) => state.index > 0);

  const [orders, setOrders] = useState<BusinessOrderSummary[]>([]);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (refreshing = false) => {
    try {
      setError('');
      if (refreshing) setIsRefreshing(true);
      const response = await businessOrderApi.getOrders();
      setOrders(response.data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load orders'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  /**
   * How many pickups are waiting on this business, for the header dot.
   *
   * Separate from `load` and deliberately silent on failure: this is a badge,
   * and a badge that cannot be fetched must not put an error over the order
   * list.
   */
  const [pendingTickets, setPendingTickets] = useState(0);

  const loadPendingTickets = useCallback(async () => {
    try {
      const response = await businessDoorApi.getInboxCounts();
      setPendingTickets(response.data?.pending_tickets ?? 0);
    } catch {
      // Ignored: the orders list is the screen, the dot is a hint.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      void loadPendingTickets();
    }, [load, loadPendingTickets])
  );

  const activeFilter = ORDER_FILTERS.find((option) => option.key === filter) || ORDER_FILTERS[0];
  const visibleOrders = activeFilter.statuses.length
    ? orders.filter((order) => activeFilter.statuses.includes(order.status))
    : orders;

  /** Counts sit on the chips, so an empty view is never a surprise. */
  const countFor = (option: (typeof ORDER_FILTERS)[number]) =>
    option.statuses.length
      ? orders.filter((order) => option.statuses.includes(order.status)).length
      : orders.length;

  const filterRow = (
    <View style={styles.filterRow}>
      {ORDER_FILTERS.map((option) => {
        const isActive = option.key === filter;
        return (
          <TouchableOpacity
            key={option.key}
            style={[styles.filterChip, isActive && styles.filterChipActive]}
            onPress={() => setFilter(option.key)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
          >
            <Text style={[styles.filterText, isActive && styles.filterTextActive]} numberOfLines={1}>
              {option.label}
            </Text>
            <Text style={[styles.filterCount, isActive && styles.filterTextActive]}>
              {countFor(option)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  /**
   * BACK TO TOP.
   *
   * The order list is long and is scrolled far more often than it is filtered,
   * so getting back to the newest order meant a long swipe. The button appears
   * only once there is somewhere to go — roughly a screen down — so it is not
   * sitting over the first card doing nothing.
   */
  const listRef = useRef<FlatList<BusinessOrderSummary>>(null);
  const [showTopButton, setShowTopButton] = useState(false);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    // Hysteresis-free but cheap: setState with the same value is a no-op in
    // React, so this does not re-render on every scroll frame.
    setShowTopButton(offset > SHOW_TOP_BUTTON_AFTER);
  };

  const scrollToTop = () => listRef.current?.scrollToOffset({ offset: 0, animated: true });

  const renderOrder = ({ item }: { item: BusinessOrderSummary }) => (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      onPress={() =>
        navigation.navigate('BusinessOrderDetailsScreen', {
          orderId: item.id,
          orderNumber: item.order_number,
        })
      }
    >
      <View style={styles.cardHeader}>
        <Text style={styles.orderNumber}>{item.order_number}</Text>
        <View style={styles.statusPill}>
          <Text style={styles.statusText}>{(item.status || '').replace(/_/g, ' ')}</Text>
        </View>
      </View>

      <Text style={styles.date}>{formatDate(item.created_at)}</Text>

      <View style={styles.tagRow}>
        {item.laundry_type ? (
          <View style={styles.tag}>
            <Text style={styles.tagText}>{LAUNDRY_LABEL[item.laundry_type] || item.laundry_type}</Text>
          </View>
        ) : null}
        {/* ONLY QUICK IS WORTH A CHIP. Standard is the default every order
            now takes, so a "Standard Order" tag on every card says nothing;
            Quick changes what the order costs, so it is flagged — and flagged
            in the warning colour, not as one more neutral tag. */}
        {item.order_type === 'quick' ? (
          <View style={[styles.tag, styles.tagQuick]}>
            <Ionicons name="flash" size={11} color={COLORS.Surface} />
            <Text style={[styles.tagText, styles.tagTextQuick]}>
              {ORDER_LABEL.quick}
            </Text>
          </View>
        ) : null}
        {item.service_type ? (
          <View style={styles.tag}>
            <Text style={styles.tagText}>
              {SERVICE_LABEL[item.service_type] || item.service_name || item.service_type}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.footerRow}>
        <Text style={styles.metaText}>
          {item.item_count} item{Number(item.item_count) === 1 ? '' : 's'} · Qty {item.total_quantity}
        </Text>
        <View style={styles.totalWrap}>
          {/* The counts on the left already say what the order holds; there is
              no weight here and no amount, as before. */}
          <Ionicons name="chevron-forward" size={16} color={COLORS.TextSecondary} />
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* NO BACK BUTTON AT THE ROOT — Your Orders is the first page of its
          tab. See BusinessCategoriesScreen for the reasoning. */}
      <BusinessHeader
        title="Your Orders"
        onBack={canGoBack ? () => navigation.goBack() : undefined}
        /*
         * The way in to Pickup Approvals. It is HERE and not on a tab of its
         * own because a rider raising a ticket is blocked until it is
         * answered, and this is the screen a business is already on when it
         * cares about a collection.
         *
         * The dot appears only when something is actually waiting, so the
         * header is unchanged on the ordinary day.
         */
        action={
          <TouchableOpacity
            style={styles.approvalsButton}
            onPress={() => navigation.navigate('BusinessDoorTicketsScreen')}
            activeOpacity={0.85}
            accessibilityLabel="Pickup approvals"
          >
            <Ionicons name="clipboard-outline" size={20} color={COLORS.Primary} />
            {pendingTickets > 0 ? <View style={styles.approvalsDot} /> : null}
          </TouchableOpacity>
        }
      />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={44} color={COLORS.Error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => load()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : orders.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="list-outline" size={48} color={COLORS.TextSecondary} />
          <Text style={styles.emptyText}>You have no orders yet.</Text>
        </View>
      ) : (
        <>
          {filterRow}

          <FlatList
            ref={listRef}
            data={visibleOrders}
            keyExtractor={(item) => item.id}
            renderItem={renderOrder}
            contentContainerStyle={styles.listContent}
            onScroll={handleScroll}
            scrollEventThrottle={64}
            ListEmptyComponent={
              <View style={styles.emptyBlock}>
                <Ionicons name="file-tray-outline" size={44} color={COLORS.TextSecondary} />
                <Text style={styles.emptyText}>
                  No {activeFilter.label.toLowerCase()} to show.
                </Text>
              </View>
            }
            refreshControl={
              <RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={COLORS.Primary} />
            }
          />

          {showTopButton ? (
            <TouchableOpacity
              style={styles.topButton}
              onPress={scrollToTop}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Scroll back to the top of the order list"
            >
              <Ionicons name="arrow-up" size={18} color={COLORS.Surface} />
              <Text style={styles.topButtonText}>Top</Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </SafeAreaView>
  );
}

/** How far down the list the "Top" button starts being useful, in pixels. */
const SHOW_TOP_BUTTON_AFTER = 400;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },

  // ---- pickup approvals entry point ----
  approvalsButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 1,
    borderColor: COLORS.Border,
  },
  /** Present only when something is waiting — see the header comment. */
  approvalsDot: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: COLORS.Warning,
  },

  /**
   * Floating, bottom-centre, above the list rather than inside it — a footer
   * row would only be reachable after the very scrolling this button exists to
   * undo.
   */
  /** Quick orders are flagged in the warning colour; standard gets no chip. */
  tagQuick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: COLORS.Error,
    borderColor: COLORS.Error,
  },
  tagTextQuick: { color: COLORS.Surface, fontWeight: '800' },

  topButton: {
    position: 'absolute',
    bottom: SPACING.lg,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: 44,
    paddingHorizontal: SPACING.lg,
    borderRadius: 22,
    backgroundColor: COLORS.PrimaryDark,
    ...SHADOWS.medium,
  },
  topButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.Surface,
  },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyBlock: { alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.xxl },

  // ---- Filters ----
  filterRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xs,
  },
  filterChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1.5,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
  },
  filterChipActive: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  filterText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  filterCount: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '800',
    color: COLORS.TextSecondary,
  },
  filterTextActive: { color: COLORS.Surface },
  emptyText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base, color: COLORS.TextSecondary },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.Error,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: { color: COLORS.Surface, fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '600' },
  listContent: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  orderNumber: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  statusPill: {
    backgroundColor: COLORS.Accent + '40',
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  statusText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
    textTransform: 'capitalize',
  },
  date: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginTop: SPACING.sm },
  tag: {
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: COLORS.Border,
  },
  tagText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, color: COLORS.TextPrimary },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
    paddingTop: SPACING.sm,
  },
  metaText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary },
  totalWrap: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  total: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
});
