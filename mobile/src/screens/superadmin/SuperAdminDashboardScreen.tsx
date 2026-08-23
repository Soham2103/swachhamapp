import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import {
  CHANNEL_COLORS, CHANNEL_ORDER, CHANNEL_LABELS, formatCurrency,
} from '../../constants/chartTheme';
import RevenueLineChart from '../../components/charts/RevenueLineChart';
import superAdminApi, {
  SalesSummary, SalesTimeseries, BusinessCompletenessRow,
} from '../../services/superAdminApi';
import { useAuthStore } from '../../store/authStore';

/**
 * Super admin landing page.
 *
 * Ordered by what needs a decision, not by what is easiest to draw:
 * headline numbers, then the trend, then the queues that are actually
 * waiting on this person, then the ways to create something new.
 */
export default function SuperAdminDashboardScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [series, setSeries] = useState<SalesTimeseries | null>(null);
  const [pendingBusinesses, setPendingBusinesses] = useState(0);
  const [pendingRiders, setPendingRiders] = useState(0);
  const [incomplete, setIncomplete] = useState<BusinessCompletenessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [s, t, pb, pr, inc] = await Promise.all([
        superAdminApi.getSalesSummary(),
        superAdminApi.getSalesTimeseries(undefined, undefined, 'day'),
        superAdminApi.getBusinessApprovals('PENDING'),
        superAdminApi.getRiderApprovals('PENDING'),
        superAdminApi.listBusinesses(true),
      ]);
      setSummary(s);
      setSeries(t);
      setPendingBusinesses(pb.length);
      setPendingRiders(pr.length);
      setIncomplete(inc);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load the dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.centered} edges={['top']}>
        <ActivityIndicator size="large" color={COLORS.Primary} />
      </SafeAreaView>
    );
  }

  const totalPending = pendingBusinesses + pendingRiders;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.header}>
          <View style={styles.flex}>
            <Text style={styles.greeting}>Super Admin</Text>
            <Text style={styles.name}>{user?.name || ''}</Text>
          </View>
          <TouchableOpacity style={styles.iconBtn} onPress={logout}>
            <Ionicons name="log-out-outline" size={22} color={COLORS.TextSecondary} />
          </TouchableOpacity>
        </View>

        {!!error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Headline numbers first: a hero figure answers "how are we
            doing" without anyone having to read a chart. */}
        {summary && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>REVENUE · LAST 30 DAYS</Text>
            <Text style={styles.hero}>{formatCurrency(summary.totals.revenue)}</Text>
            <Text style={styles.heroSub}>
              {summary.totals.orders} orders
              {summary.totals.cancelled_orders > 0
                ? ` · ${summary.totals.cancelled_orders} cancelled`
                : ''}
            </Text>

            <View style={styles.channelRow}>
              {CHANNEL_ORDER.map((channel) => {
                const row = summary.channels.find((c) => c.channel === channel);
                return (
                  <View key={channel} style={styles.channelTile}>
                    <View style={styles.channelHead}>
                      <View style={[styles.swatch, { backgroundColor: CHANNEL_COLORS[channel] }]} />
                      <Text style={styles.channelName}>{CHANNEL_LABELS[channel]}</Text>
                    </View>
                    <Text style={styles.channelValue}>{formatCurrency(row?.revenue || 0)}</Text>
                    <Text style={styles.channelMeta}>{row?.orders || 0} orders</Text>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* The trend. Legend is always present for two series, so identity
            never rests on colour alone. */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>Revenue trend</Text>
            <View style={styles.legend}>
              {CHANNEL_ORDER.map((channel) => (
                <View key={channel} style={styles.legendItem}>
                  <View style={[styles.swatch, { backgroundColor: CHANNEL_COLORS[channel] }]} />
                  <Text style={styles.legendText}>{CHANNEL_LABELS[channel]}</Text>
                </View>
              ))}
            </View>
          </View>
          <RevenueLineChart points={series?.points || []} />
        </View>

        {/* Queues waiting on this person. */}
        <Text style={styles.sectionTitle}>Approvals</Text>
        <View style={styles.row}>
          <QueueTile
            icon="business-outline"
            label="Businesses"
            count={pendingBusinesses}
            onPress={() => navigation.navigate('SuperAdminApprovals', { tab: 'businesses' })}
          />
          <QueueTile
            icon="bicycle-outline"
            label="Riders"
            count={pendingRiders}
            onPress={() => navigation.navigate('SuperAdminApprovals', { tab: 'riders' })}
          />
        </View>
        {totalPending === 0 && <Text style={styles.emptyNote}>Nothing waiting for approval.</Text>}

        {/* Incomplete onboarding is a queue too: these businesses cannot
            order until someone fills the gaps in. */}
        {incomplete.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Incomplete onboarding</Text>
            <View style={styles.card}>
              <Text style={styles.warnNote}>
                {incomplete.length} business{incomplete.length === 1 ? '' : 'es'} cannot place
                orders until their details are completed.
              </Text>
              {incomplete.slice(0, 4).map((b) => (
                <TouchableOpacity
                  key={b.business_id}
                  style={styles.incompleteRow}
                  onPress={() =>
                    navigation.navigate('SuperAdminBusinessDetails', { businessId: b.business_id })
                  }
                >
                  <View style={styles.flex}>
                    <Text style={styles.incompleteName}>{b.business_name}</Text>
                    <Text style={styles.incompleteMissing}>
                      Missing: {b.missing_fields.map((f) => f.label).join(', ')}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
                </TouchableOpacity>
              ))}
              {incomplete.length > 4 && (
                <TouchableOpacity onPress={() => navigation.navigate('SuperAdminBusinessList')}>
                  <Text style={styles.linkText}>View all {incomplete.length}</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        {/* The "Create" section is gone. A Super Admin does not create a
            business or a rider -- a Manager proposes one and this screen's
            Requests section is where it is approved, which is the same
            workflow that already existed. Everything else about managing an
            existing business or rider is unchanged. */}

        {/* Requests raised by Managers, waiting on a decision here. */}
        <Text style={styles.sectionTitle}>Requests</Text>
        <View style={styles.row}>
          <ActionTile
            icon="business-outline"
            label="Business requests"
            onPress={() => navigation.navigate('SuperAdminRequests', { type: 'BUSINESS' })}
          />
          <ActionTile
            icon="bicycle-outline"
            label="Rider requests"
            onPress={() => navigation.navigate('SuperAdminRequests', { type: 'RIDER' })}
          />
        </View>
        <View style={styles.row}>
          <ActionTile
            icon="shirt-outline"
            label="Sorter requests"
            onPress={() => navigation.navigate('SuperAdminRequests', { type: 'SORTER' })}
          />
          <ActionTile
            icon="people-outline"
            label="Managers"
            onPress={() => navigation.navigate('SuperAdminManagers')}
          />
        </View>

        <Text style={styles.sectionTitle}>Manage</Text>

        {/* One business's orders, invoices and payments, in one place. */}
        <TouchableOpacity
          style={[styles.wideAction, { marginBottom: SPACING.sm }]}
          onPress={() => navigation.navigate('SuperAdminBusinessAccount')}
        >
          <Ionicons name="wallet-outline" size={18} color={COLORS.Primary} />
          <Text style={styles.wideActionText}>Business Account</Text>
          <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
        </TouchableOpacity>

        {/* Price List: the customer list and the per-business lists, both
            behind one entry because they are one job. */}
        <TouchableOpacity
          style={[styles.wideAction, { marginBottom: SPACING.sm }]}
          onPress={() => navigation.navigate('SuperAdminPriceList')}
        >
          <Ionicons name="pricetags-outline" size={18} color={COLORS.Primary} />
          <Text style={styles.wideActionText}>Price List</Text>
          <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
        </TouchableOpacity>

        {/* Edit, enable, disable and delete a business, and its contacts.
            Separate from "All businesses" below, which answers the narrower
            question of which records are still missing details. */}
        <TouchableOpacity
          style={[styles.wideAction, { marginBottom: SPACING.sm }]}
          onPress={() => navigation.navigate('SuperAdminManageBusinesses')}
        >
          <Ionicons name="business-outline" size={18} color={COLORS.Primary} />
          <Text style={styles.wideActionText}>Manage businesses</Text>
          <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.wideAction}
          onPress={() => navigation.navigate('SuperAdminBusinessList')}
        >
          <Ionicons name="list-outline" size={18} color={COLORS.Primary} />
          <Text style={styles.wideActionText}>All businesses</Text>
          <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function QueueTile({ icon, label, count, onPress }: any) {
  return (
    <TouchableOpacity style={styles.tile} onPress={onPress}>
      <Ionicons name={icon} size={20} color={COLORS.Primary} />
      <Text style={styles.tileCount}>{count}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
      {count > 0 && <View style={styles.dot} />}
    </TouchableOpacity>
  );
}

function ActionTile({ icon, label, onPress }: any) {
  return (
    <TouchableOpacity style={styles.tile} onPress={onPress}>
      <Ionicons name={icon} size={22} color={COLORS.Primary} />
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.Background },
  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md },
  greeting: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600', color: COLORS.Primary, letterSpacing: 1,
  },
  name: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold', color: COLORS.TextPrimary,
  },
  iconBtn: { padding: SPACING.sm },
  card: {
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, marginBottom: SPACING.md,
    borderWidth: 1, borderColor: COLORS.Border,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm },
  cardLabel: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 10, fontWeight: '700',
    color: COLORS.TextSecondary, letterSpacing: 1,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.TextPrimary, flex: 1,
  },
  hero: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 32, fontWeight: 'bold',
    color: COLORS.TextPrimary, marginTop: SPACING.xs,
  },
  heroSub: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary, marginBottom: SPACING.md,
  },
  channelRow: { flexDirection: 'row', gap: SPACING.sm },
  channelTile: {
    flex: 1, backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.md, padding: SPACING.sm,
  },
  channelHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  channelName: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
  channelValue: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  channelMeta: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, color: COLORS.TextSecondary,
  },
  legend: { flexDirection: 'row', gap: SPACING.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, color: COLORS.TextSecondary,
  },
  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.TextPrimary,
    marginTop: SPACING.sm, marginBottom: SPACING.sm,
  },
  row: { flexDirection: 'row', gap: SPACING.sm },
  tile: {
    flex: 1, backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, alignItems: 'flex-start',
    borderWidth: 1, borderColor: COLORS.Border, marginBottom: SPACING.sm,
  },
  tileCount: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 26, fontWeight: 'bold',
    color: COLORS.TextPrimary, marginTop: SPACING.xs,
  },
  tileLabel: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  actionLabel: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.TextPrimary, marginTop: SPACING.sm,
  },
  dot: {
    position: 'absolute', top: SPACING.md, right: SPACING.md,
    width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.Warning,
  },
  emptyNote: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary, marginBottom: SPACING.sm,
  },
  warnNote: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Warning, marginBottom: SPACING.sm,
  },
  incompleteRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SPACING.sm, borderTopWidth: 1, borderTopColor: COLORS.Border,
  },
  incompleteName: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.TextPrimary,
  },
  incompleteMissing: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, color: COLORS.TextSecondary,
  },
  linkText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Primary, paddingTop: SPACING.sm,
  },
  wideAction: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.Border,
  },
  wideActionText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.TextPrimary, flex: 1,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: '#FDECEC', borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm, marginBottom: SPACING.md,
  },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Error, flex: 1,
  },
});
