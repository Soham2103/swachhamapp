import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { sa } from '../superadmin/styles';
import { StatusPill } from './ManagerDashboardScreen';
import managerApi, { CreationRequest } from '../../services/managerApi';

/**
 * My Requests.
 *
 * Everything this Manager has submitted, and what became of it. Read-only by
 * design: there is no control here that changes a status, because a Manager
 * cannot approve — not their own request and not anyone else's.
 *
 * The list comes from `/api/manager/requests`, which the server scopes to the
 * signed-in manager. Another manager's request is not merely hidden from this
 * screen; it is not in the response.
 */

type Filter = 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED';
const FILTERS: Filter[] = ['ALL', 'PENDING', 'APPROVED', 'REJECTED'];

export default function ManagerRequestsScreen({ navigation }: any) {
  const [rows, setRows] = useState<CreationRequest[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await managerApi.listRequests());
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load your requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shown = useMemo(
    () => (filter === 'ALL' ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter]
  );

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>My Requests</Text>
      </View>

      <View style={sa.tabs}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[sa.tab, filter === f && sa.tabActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[sa.tabText, filter === f && sa.tabTextActive]}>
              {f === 'ALL' ? `All (${rows.length})` : f.charAt(0) + f.slice(1).toLowerCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={sa.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={sa.scroll}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
          }
        >
          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          {shown.length === 0 && (
            <Text style={sa.empty}>
              {rows.length === 0
                ? 'You have not submitted any requests yet.'
                : 'Nothing with that status.'}
            </Text>
          )}

          {shown.map((r) => {
            const open = expanded === r.id;
            return (
              <TouchableOpacity
                key={r.id}
                style={sa.card}
                activeOpacity={0.8}
                onPress={() => setExpanded(open ? null : r.id)}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                  <View style={sa.flex}>
                    <Text style={sa.cardTitle}>{r.subject_name}</Text>
                    <Text style={sa.cardMeta}>
                      {r.request_type} · submitted {new Date(r.created_at).toLocaleDateString()}
                    </Text>
                    {r.subject_email ? (
                      <Text style={sa.cardMeta}>{r.subject_email}</Text>
                    ) : null}
                  </View>
                  <StatusPill status={r.status} />
                </View>

                {/* Why it was turned down, so it can be corrected and resubmitted. */}
                {r.status === 'REJECTED' && r.rejection_reason ? (
                  <View style={[sa.warnBox, { marginTop: SPACING.sm, marginBottom: 0 }]}>
                    <Ionicons name="information-circle-outline" size={16} color="#8A5200" />
                    <Text style={sa.warnText}>Reason: {r.rejection_reason}</Text>
                  </View>
                ) : null}

                {open && (
                  <View style={{ marginTop: SPACING.sm }}>
                    {r.request_type === 'BUSINESS' ? (
                      <>
                        <Detail label="Registration type" value={r.payload?.registration_type} />
                        {/* Renders nothing for a B2C request, which carries
                            no GST number by definition. */}
                        <Detail label="GST number" value={r.payload?.gstin} />
                        <Detail label="PAN" value={r.payload?.pan_number} />
                        <Detail label="Billing cycle" value={r.payload?.billing_cycle} />
                        <Detail label="Legal address" value={r.payload?.legal_address} />
                        <Detail label="Business head" value={r.payload?.business_head?.name} />
                        <Detail label="Head mobile" value={r.payload?.business_head?.mobile} />
                        <Detail
                          label="Alternative contacts"
                          value={(r.payload?.alternative_contacts || [])
                            .map((c: any) => c.name)
                            .join(', ')}
                        />
                      </>
                    ) : (
                      <>
                        <Detail label="Email" value={r.payload?.email} />
                        <Detail label="Mobile" value={r.payload?.mobile_number} />
                      </>
                    )}
                    {r.status === 'APPROVED' ? (
                      <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
                        Approved {r.approved_at ? new Date(r.approved_at).toLocaleDateString() : ''}
                        {/* Whether the credentials reached them is the Super
                            Admin's to act on, but it is shown here too so the
                            Manager knows why nobody can log in yet. */}
                        {r.email_status === 'FAILED'
                          ? ' · the credentials email did not send'
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                )}

                <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
                  {open ? 'Tap to collapse' : 'Tap for details'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', gap: SPACING.sm, paddingVertical: 2 }}>
      <Text
        style={{
          fontFamily: TYPOGRAPHY.fontFamily,
          fontSize: TYPOGRAPHY.sizes.xs,
          color: COLORS.TextSecondary,
          width: 130,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          flex: 1,
          fontFamily: TYPOGRAPHY.fontFamily,
          fontSize: TYPOGRAPHY.sizes.sm,
          color: COLORS.TextPrimary,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
