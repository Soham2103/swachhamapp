import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { sa, STATUS_TONE } from './styles';
import superAdminApi, { PendingBusiness, PendingRider } from '../../services/superAdminApi';

type Tab = 'businesses' | 'riders';

/**
 * The approval queue for both kinds of applicant.
 *
 * Approve and Reject sit next to each other because they are equally
 * ordinary outcomes, but Reject asks for confirmation: approving a
 * business can be undone by deactivating it, while a rejection is the
 * end of that application.
 */
export default function SuperAdminApprovalsScreen({ navigation, route }: any) {
  const [tab, setTab] = useState<Tab>(route?.params?.tab === 'riders' ? 'riders' : 'businesses');
  const [businesses, setBusinesses] = useState<PendingBusiness[]>([]);
  const [riders, setRiders] = useState<PendingRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [b, r] = await Promise.all([
        superAdminApi.getBusinessApprovals('PENDING'),
        superAdminApi.getRiderApprovals('PENDING'),
      ]);
      setBusinesses(b);
      setRiders(r);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load approvals');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const decide = async (
    kind: Tab,
    id: string,
    name: string,
    action: 'approve' | 'reject'
  ) => {
    const run = async () => {
      setBusyId(id);
      setError('');
      try {
        if (kind === 'businesses') await superAdminApi.decideBusiness(id, action);
        else await superAdminApi.decideRider(id, action);
        await load();
      } catch (e: any) {
        setError(e?.response?.data?.message || e.message || 'Could not save that decision');
      } finally {
        setBusyId(null);
      }
    };

    if (action === 'reject') {
      Alert.alert(
        'Reject ' + name + '?',
        'They will not be able to sign in. You can still find the record afterwards.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Reject', style: 'destructive', onPress: run },
        ]
      );
      return;
    }
    run();
  };

  const items = tab === 'businesses' ? businesses : riders;

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>Approvals</Text>
      </View>

      <View style={sa.tabs}>
        {(['businesses', 'riders'] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[sa.tab, tab === t && sa.tabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[sa.tabText, tab === t && sa.tabTextActive]}>
              {t === 'businesses' ? 'Businesses' : 'Riders'}
              {(t === 'businesses' ? businesses.length : riders.length) > 0
                ? ` (${t === 'businesses' ? businesses.length : riders.length})`
                : ''}
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

          {items.length === 0 && (
            <Text style={sa.empty}>
              No {tab === 'businesses' ? 'businesses' : 'riders'} waiting for approval.
            </Text>
          )}

          {tab === 'businesses' &&
            businesses.map((b) => (
              <View key={b.id} style={sa.card}>
                <Text style={sa.cardTitle}>{b.name}</Text>
                <Text style={sa.cardMeta}>
                  {[b.business_type, b.city].filter(Boolean).join(' · ') || 'No type given'}
                </Text>
                <Text style={sa.cardMeta}>
                  {b.contact_person_name || 'No contact person'}
                  {b.mobile_number ? ' · ' + b.mobile_number : ''}
                </Text>
                {!!b.email && <Text style={sa.cardMeta}>{b.email}</Text>}
                <Text style={sa.cardMeta}>
                  GST: {b.gst_number || 'not provided'}
                </Text>
                <Pill status={b.status} />
                <Decision
                  busy={busyId === b.id}
                  onApprove={() => decide('businesses', b.id, b.name, 'approve')}
                  onReject={() => decide('businesses', b.id, b.name, 'reject')}
                />
              </View>
            ))}

          {tab === 'riders' &&
            riders.map((r) => (
              <View key={r.id} style={sa.card}>
                <Text style={sa.cardTitle}>{r.name || 'Unnamed rider'}</Text>
                <Text style={sa.cardMeta}>{r.mobile_number}</Text>
                {!!r.email && <Text style={sa.cardMeta}>{r.email}</Text>}
                <Pill status={r.approval_status || 'PENDING'} />
                <Decision
                  busy={busyId === r.id}
                  onApprove={() => decide('riders', r.id, r.name || 'this rider', 'approve')}
                  onReject={() => decide('riders', r.id, r.name || 'this rider', 'reject')}
                />
              </View>
            ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

export function Pill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.INACTIVE;
  return (
    <View style={[sa.pill, { backgroundColor: tone.bg }]}>
      <Text style={[sa.pillText, { color: tone.fg }]}>{status}</Text>
    </View>
  );
}

function Decision({ busy, onApprove, onReject }: any) {
  if (busy) {
    return (
      <View style={sa.rowBtns}>
        <ActivityIndicator color={COLORS.Primary} />
      </View>
    );
  }
  return (
    <View style={sa.rowBtns}>
      <TouchableOpacity style={sa.approve} onPress={onApprove}>
        <Text style={sa.approveText}>Approve</Text>
      </TouchableOpacity>
      <TouchableOpacity style={sa.reject} onPress={onReject}>
        <Text style={sa.rejectText}>Reject</Text>
      </TouchableOpacity>
    </View>
  );
}
