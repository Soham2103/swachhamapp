import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';
import { sa } from './styles';
import { Pill } from './SuperAdminApprovalsScreen';
import superAdminApi, { BusinessCompletenessRow } from '../../services/superAdminApi';

/**
 * Every business, with whether it can actually trade.
 *
 * The filter defaults to "needs attention" because that is the reason
 * someone opens this screen; the complete ones are one tap away.
 */
export default function SuperAdminBusinessListScreen({ navigation }: any) {
  const [rows, setRows] = useState<BusinessCompletenessRow[]>([]);
  /** The business whose invoice is being generated, if any. */
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await superAdminApi.listBusinesses(false));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load businesses');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shown = onlyIncomplete ? rows.filter((r) => !r.is_complete) : rows;

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>Businesses</Text>
      </View>

      <View style={sa.tabs}>
        <TouchableOpacity
          style={[sa.tab, onlyIncomplete && sa.tabActive]}
          onPress={() => setOnlyIncomplete(true)}
        >
          <Text style={[sa.tabText, onlyIncomplete && sa.tabTextActive]}>
            Needs attention ({rows.filter((r) => !r.is_complete).length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sa.tab, !onlyIncomplete && sa.tabActive]}
          onPress={() => setOnlyIncomplete(false)}
        >
          <Text style={[sa.tabText, !onlyIncomplete && sa.tabTextActive]}>
            All ({rows.length})
          </Text>
        </TouchableOpacity>
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
              {onlyIncomplete ? 'Every business has its required details.' : 'No businesses yet.'}
            </Text>
          )}

          {shown.map((b) => (
            <TouchableOpacity
              key={b.business_id}
              style={sa.card}
              onPress={() =>
                navigation.navigate('SuperAdminBusinessDetails', { businessId: b.business_id })
              }
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                <View style={sa.flex}>
                  <Text style={sa.cardTitle}>{b.business_name}</Text>
                  {b.is_complete ? (
                    <Text style={sa.cardMeta}>Ready to order</Text>
                  ) : (
                    <Text style={[sa.cardMeta, { color: COLORS.Warning }]}>
                      Missing: {b.missing_fields.map((f) => f.label).join(', ')}
                    </Text>
                  )}
                  {/* The GSTIN on file, from the record itself. */}
                  {b.gst_number ? (
                    <Text style={sa.cardMeta}>GSTIN: {b.gst_number}</Text>
                  ) : null}
                  <Pill status={b.status} />
                </View>
                <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
              </View>

              {/* Generate Invoice moved to Business Account -> Order Detail,
                  where the business's orders are on screen beside it. The
                  endpoints and the modal are unchanged; only the entry point
                  is. */}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
