import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { sa, STATUS_TONE } from '../superadmin/styles';
import managerApi, { CreationRequest } from '../../services/managerApi';
import { useAuthStore } from '../../store/authStore';

/**
 * Manager dashboard.
 *
 * A Manager creates PROPOSALS, not accounts. Everything reachable from here
 * submits a request that a Super Admin has to approve — there is deliberately
 * no approve, reject or credentials control anywhere in this section, and the
 * server would refuse one anyway.
 *
 * Reuses the Super Admin chrome (`sa`) rather than introducing a second admin
 * design language: the two sections are the same kind of surface.
 */
export default function ManagerDashboardScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<CreationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [summary, requests] = await Promise.all([
        managerApi.getSummary(),
        managerApi.listRequests(),
      ]);
      setCounts(summary.counts || {});
      setRecent(requests.slice(0, 5));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load the dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return (
      <SafeAreaView style={sa.centered} edges={['top']}>
        <ActivityIndicator size="large" color={COLORS.Primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={sa.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
        }
      >
        <View style={[sa.header, { paddingHorizontal: 0 }]}>
          <View style={sa.flex}>
            <Text
              style={{
                fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
                fontWeight: '600', color: COLORS.Primary, letterSpacing: 1,
              }}
            >
              MANAGER
            </Text>
            <Text style={sa.headerTitle}>{user?.name || ''}</Text>
          </View>
          <TouchableOpacity style={sa.iconBtn} onPress={logout} accessibilityLabel="Log out">
            <Ionicons name="log-out-outline" size={22} color={COLORS.TextSecondary} />
          </TouchableOpacity>
        </View>

        {!!error && (
          <View style={sa.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
            <Text style={sa.errorText}>{error}</Text>
          </View>
        )}

        {/* What is waiting on someone else. */}
        <View style={{ flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.md }}>
          <CountTile label="Pending" value={counts.PENDING || 0} tone="PENDING" />
          <CountTile label="Approved" value={counts.APPROVED || 0} tone="APPROVED" />
          <CountTile label="Rejected" value={counts.REJECTED || 0} tone="REJECTED" />
        </View>

        <Text style={sa.label}>CREATE A REQUEST</Text>
        <Action
          icon="business-outline"
          title="New Business"
          subtitle="GST-verified, sent for approval"
          onPress={() => navigation.navigate('ManagerNewBusiness')}
        />
        <Action
          icon="bicycle-outline"
          title="New Rider"
          subtitle="Rider details, sent for approval"
          onPress={() => navigation.navigate('ManagerNewStaff', { kind: 'RIDER' })}
        />
        <Action
          icon="shirt-outline"
          title="New Sorter"
          subtitle="Sorter details, sent for approval"
          onPress={() => navigation.navigate('ManagerNewStaff', { kind: 'SORTER' })}
        />

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: SPACING.md }}>
          <Text style={[sa.label, sa.flex]}>MY REQUESTS</Text>
          <TouchableOpacity onPress={() => navigation.navigate('ManagerRequests')}>
            <Text style={{
              fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
              color: COLORS.Primary, fontWeight: '600',
            }}>
              View all
            </Text>
          </TouchableOpacity>
        </View>

        {recent.length === 0 ? (
          <Text style={sa.empty}>You have not submitted any requests yet.</Text>
        ) : (
          recent.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={sa.card}
              onPress={() => navigation.navigate('ManagerRequests', { focusId: r.id })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                <View style={sa.flex}>
                  <Text style={sa.cardTitle}>{r.subject_name}</Text>
                  <Text style={sa.cardMeta}>
                    {r.request_type} · {new Date(r.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <StatusPill status={r.status} />
              </View>
            </TouchableOpacity>
          ))
        )}

        {/* Says plainly what this role can and cannot do, so nobody hunts for
            an approve button that is not there by design. */}
        <Text
          style={{
            fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
            color: COLORS.TextSecondary, marginTop: SPACING.md, lineHeight: 18,
          }}
        >
          Requests you submit are reviewed by a Super Admin. Accounts and passwords are
          created only after approval.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const colours = STATUS_TONE[tone] || STATUS_TONE.INACTIVE;
  return (
    <View style={[sa.card, { flex: 1, marginBottom: 0, backgroundColor: colours.bg }]}>
      <Text style={{
        fontFamily: TYPOGRAPHY.fontFamily, fontSize: 24, fontWeight: 'bold', color: colours.fg,
      }}>
        {value}
      </Text>
      <Text style={{
        fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs, color: colours.fg,
      }}>
        {label}
      </Text>
    </View>
  );
}

function Action({ icon, title, subtitle, onPress }: any) {
  return (
    <TouchableOpacity
      style={[sa.card, { flexDirection: 'row', alignItems: 'center', gap: SPACING.md }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
    >
      <View style={{
        width: 42, height: 42, borderRadius: BORDER_RADIUS.md,
        backgroundColor: COLORS.Accent, alignItems: 'center', justifyContent: 'center',
      }}>
        <Ionicons name={icon} size={20} color={COLORS.PrimaryDark} />
      </View>
      <View style={sa.flex}>
        <Text style={sa.cardTitle}>{title}</Text>
        <Text style={sa.cardMeta}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
    </TouchableOpacity>
  );
}

/** Status is never colour alone: every pill carries its word. */
export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.INACTIVE;
  return (
    <View style={[sa.pill, { backgroundColor: tone.bg, marginTop: 0 }]}>
      <Text style={[sa.pillText, { color: tone.fg }]}>{status}</Text>
    </View>
  );
}
