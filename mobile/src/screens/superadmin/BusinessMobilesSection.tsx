import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { sa } from './styles';
import superAdminApi, { MobileList } from '../../services/superAdminApi';

/**
 * The mobile numbers a business answers on.
 *
 * These are not just contact details: any number here can sign in to the
 * business, which is why the allowance exists and why the last number
 * cannot be removed. The screen says both of those things out loud
 * rather than only enforcing them when a button fails.
 */
export default function BusinessMobilesSection({ businessId }: { businessId: string }) {
  const [data, setData] = useState<MobileList | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await superAdminApi.getBusinessMobiles(businessId));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load mobile numbers');
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    load();
  }, [load]);

  const atCap = !!data && data.remaining <= 0;

  const add = async () => {
    setError('');
    setWarning('');
    if (!/^[6-9]\d{9}$/.test(newNumber.trim())) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }
    setBusy(true);
    try {
      const result = await superAdminApi.addBusinessMobile(businessId, {
        mobile_number: newNumber.trim(),
        label: newLabel.trim() || undefined,
      });
      setData(result);
      setNewNumber('');
      setNewLabel('');
      // The add succeeded; a warning here means the number is now
      // ambiguous, which the person adding it needs to know now.
      if (result.warning && /also used by/i.test(result.warning)) setWarning(result.warning);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not add the number');
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string, number: string) => {
    Alert.alert('Remove ' + number + '?', 'It will no longer be able to sign in to this business.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError('');
          try {
            setData(await superAdminApi.removeBusinessMobile(businessId, id));
          } catch (e: any) {
            setError(e?.response?.data?.message || e.message || 'Could not remove the number');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const makePrimary = async (number: string) => {
    setBusy(true);
    setError('');
    try {
      setData(await superAdminApi.setPrimaryMobile(businessId, number));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not set the primary number');
    } finally {
      setBusy(false);
    }
  };

  const changeAllowance = (delta: number) => async () => {
    if (!data) return;
    const next = data.max_mobiles + delta;
    if (next < 1) return;
    setBusy(true);
    setError('');
    try {
      setData(await superAdminApi.setMobileAllowance(businessId, next));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not change the limit');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[sa.card, { alignItems: 'center' }]}>
        <ActivityIndicator color={COLORS.Primary} />
      </View>
    );
  }

  return (
    <View style={sa.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[sa.cardTitle, { flex: 1 }]}>Mobile numbers</Text>
        <Text style={sa.cardMeta}>
          {data?.used ?? 0} of {data?.max_mobiles ?? 1} used
        </Text>
      </View>
      <Text style={[sa.cardMeta, { marginBottom: SPACING.sm }]}>
        Any number here can sign in to this business.
      </Text>

      {/* The allowance. Only a super admin reaches this screen, so the
          control lives here rather than being hidden behind a role check
          the screen cannot enforce anyway. */}
      <View style={styles.allowanceRow}>
        <Text style={styles.allowanceLabel}>Numbers allowed</Text>
        <TouchableOpacity
          style={[styles.stepper, (busy || (data?.max_mobiles ?? 1) <= 1) && sa.buttonDisabled]}
          onPress={changeAllowance(-1)}
          disabled={busy || (data?.max_mobiles ?? 1) <= 1}
        >
          <Ionicons name="remove" size={18} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={styles.allowanceValue}>{data?.max_mobiles ?? 1}</Text>
        <TouchableOpacity
          style={[styles.stepper, busy && sa.buttonDisabled]}
          onPress={changeAllowance(1)}
          disabled={busy}
        >
          <Ionicons name="add" size={18} color={COLORS.TextPrimary} />
        </TouchableOpacity>
      </View>

      {data?.mobiles.map((m) => (
        <View key={m.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.number}>{m.mobile_number}</Text>
              {m.is_primary && (
                <View style={styles.primaryPill}>
                  <Text style={styles.primaryPillText}>PRIMARY</Text>
                </View>
              )}
            </View>
            {!!m.label && <Text style={sa.cardMeta}>{m.label}</Text>}
          </View>

          {!m.is_primary && (
            <TouchableOpacity
              style={styles.rowAction}
              onPress={() => makePrimary(m.mobile_number)}
              disabled={busy}
            >
              <Ionicons name="star-outline" size={18} color={COLORS.Primary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.rowAction}
            onPress={() => remove(m.id, m.mobile_number)}
            // The last number is not removable; showing it greyed out
            // explains the rule better than an error after the fact.
            disabled={busy || (data?.used ?? 0) <= 1}
          >
            <Ionicons
              name="trash-outline"
              size={18}
              color={(data?.used ?? 0) <= 1 ? COLORS.Border : COLORS.Error}
            />
          </TouchableOpacity>
        </View>
      ))}

      {atCap ? (
        <Text style={[sa.cardMeta, { marginTop: SPACING.sm, color: COLORS.Warning }]}>
          Limit reached. Raise "Numbers allowed" to add another.
        </Text>
      ) : (
        <View style={styles.addBox}>
          <TextInput
            style={[sa.input, { flex: 1.4 }]}
            value={newNumber}
            onChangeText={setNewNumber}
            keyboardType="number-pad"
            maxLength={10}
            placeholder="Add a number"
            placeholderTextColor={COLORS.TextSecondary}
          />
          <TextInput
            style={[sa.input, { flex: 1 }]}
            value={newLabel}
            onChangeText={setNewLabel}
            placeholder="Label"
            placeholderTextColor={COLORS.TextSecondary}
          />
          <TouchableOpacity
            style={[styles.addBtn, busy && sa.buttonDisabled]}
            onPress={add}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={COLORS.Surface} size="small" />
            ) : (
              <Ionicons name="add" size={20} color={COLORS.Surface} />
            )}
          </TouchableOpacity>
        </View>
      )}

      {!!warning && (
        <View style={[sa.warnBox, { marginTop: SPACING.sm }]}>
          <Ionicons name="alert-circle-outline" size={16} color="#8A5200" />
          <Text style={sa.warnText}>{warning}</Text>
        </View>
      )}
      {!!error && (
        <View style={[sa.errorBox, { marginTop: SPACING.sm, marginBottom: 0 }]}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
          <Text style={sa.errorText}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  allowanceRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.Border,
    marginBottom: SPACING.xs,
  },
  allowanceLabel: {
    flex: 1, fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary,
  },
  allowanceValue: {
    minWidth: 24, textAlign: 'center',
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  stepper: {
    width: 32, height: 32, borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1, borderColor: COLORS.Border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.Background,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.Border,
  },
  number: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.TextPrimary,
  },
  primaryPill: {
    backgroundColor: '#E6F4EC', paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: BORDER_RADIUS.full,
  },
  primaryPillText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 9, fontWeight: '700', color: '#1B4332',
  },
  rowAction: { padding: SPACING.xs },
  addBox: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.sm },
  addBtn: {
    width: 44, height: 44, borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary, alignItems: 'center', justifyContent: 'center',
  },
});
