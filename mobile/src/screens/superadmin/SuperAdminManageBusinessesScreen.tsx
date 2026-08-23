import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  TextInput, Alert, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';
import { sa, STATUS_TONE } from './styles';
import superAdminApi, { BusinessAdmin } from '../../services/superAdminApi';
import { ActionButton } from './SuperAdminCustomerPricesScreen';
import PasswordFields, { passwordProblem } from './PasswordFields';

/**
 * Businesses — the management page.
 *
 * One row per business with what identifies it and what can be done to it:
 * View, Edit, Password, Enable/Disable and Delete. Edit opens the FULL
 * registration form, not a cut-down one.
 *
 * PRINT PDF IS NOT HERE. It belongs to one business's profile, so it lives on
 * the VIEW page where that profile is on screen — printing a record you are
 * not looking at is how the wrong business's document gets sent.
 *
 * DELETE IS NOT ALWAYS A DELETE, and the screen says so before it happens. A
 * business whose orders have been invoiced cannot be removed without taking
 * those invoices with it, so the server deactivates it instead and reports
 * which it did — the alert afterwards repeats the server's own words rather
 * than claiming a deletion that did not occur.
 *
 * Nothing here decides a business's fate locally: every action is a call, and
 * the list is reloaded from the server afterwards.
 */

const COLS = { business: 190, gstin: 160, type: 76, billing: 108, status: 96, actions: 306 };
const TABLE_WIDTH = Object.values(COLS).reduce((sum, width) => sum + width, 0);

const STATUSES = ['ALL', 'ACTIVE', 'INACTIVE', 'PENDING', 'REJECTED'];

export default function SuperAdminManageBusinessesScreen({ navigation }: any) {
  const [rows, setRows] = useState<BusinessAdmin[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  /** The business whose password is being set, or null when the sheet is shut. */
  const [passwordFor, setPasswordFor] = useState<BusinessAdmin | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await superAdminApi.getManagedBusinesses());
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load businesses');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Searched locally: the whole list is one page, so a round trip per
  // keystroke would be slower than it is worth.
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((b) => {
      if (status !== 'ALL' && b.status !== status) return false;
      if (!needle) return true;
      return (
        b.name.toLowerCase().includes(needle) ||
        (b.establishment_name || '').toLowerCase().includes(needle) ||
        (b.gst_number || '').toLowerCase().includes(needle) ||
        (b.account_email || '').toLowerCase().includes(needle)
      );
    });
  }, [rows, search, status]);

  const toggleActive = async (b: BusinessAdmin) => {
    const enabling = b.status !== 'ACTIVE';
    try {
      await superAdminApi.setBusinessActive(b.id, enabling);
      load();
    } catch (e: any) {
      Alert.alert('Could not update', e?.response?.data?.message || e.message);
    }
  };

  /**
   * Delete, with the consequences stated first.
   *
   * The order count is shown because it is what decides the outcome: a
   * business with orders on record is deactivated by the server instead, and
   * its invoices stay readable.
   */
  const confirmDelete = (b: BusinessAdmin) => {
    const hasHistory = b.order_count > 0;
    Alert.alert(
      'Delete Business?',
      `${b.name}\n\n` +
        (hasHistory
          ? `This business has ${b.order_count} order(s) on record. Its invoices depend on them, ` +
            'so it will be DISABLED rather than deleted — the history stays available to you.'
          : 'This business has no orders on record. It will be permanently deleted, along with ' +
            'its login account, contacts and price list.\n\nThis action cannot be undone.'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: hasHistory ? 'Disable Business' : 'Delete Business',
          style: 'destructive',
          onPress: async () => {
            try {
              const result = await superAdminApi.deleteBusiness(b.id);
              // The server's own message: it knows whether the row went or
              // was deactivated, and this screen does not second-guess it.
              Alert.alert(result.deleted ? 'Business deleted' : 'Business disabled', result.message);
              load();
            } catch (e: any) {
              Alert.alert('Could not delete', e?.response?.data?.message || e.message);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>Businesses</Text>
      </View>

      <View style={{ paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm }}>
        <TextInput
          style={sa.input}
          placeholder="Search Business (name, GSTIN or login email)"
          placeholderTextColor={COLORS.TextSecondary}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={sa.filterBar}
      >
        {STATUSES.map((value) => {
          const on = status === value;
          return (
            <TouchableOpacity
              key={value}
              style={[sa.filterChip, on && sa.filterChipOn]}
              onPress={() => setStatus(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[sa.filterChipText, on && sa.filterChipTextOn]}>
                {value === 'ALL' ? 'All' : value.charAt(0) + value.slice(1).toLowerCase()}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={sa.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={sa.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
        >
          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          {shown.length === 0 ? (
            <Text style={sa.empty}>
              {rows.length === 0 ? 'No businesses yet.' : 'No business matches that search.'}
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={[sa.tableWrap, { width: TABLE_WIDTH }]}>
                <View style={sa.tableHeadRow}>
                  <Text style={[sa.th, { width: COLS.business }]}>BUSINESS</Text>
                  <Text style={[sa.th, { width: COLS.gstin }]}>GSTIN</Text>
                  <Text style={[sa.th, { width: COLS.type }]}>TYPE</Text>
                  <Text style={[sa.th, { width: COLS.billing }]}>BILLING</Text>
                  <Text style={[sa.th, { width: COLS.status }]}>STATUS</Text>
                  <Text style={[sa.th, { width: COLS.actions }]}>ACTIONS</Text>
                </View>

                {shown.map((b) => (
                  <View key={b.id} style={sa.tableRow}>
                    <View style={{ width: COLS.business, paddingRight: SPACING.xs }}>
                      <Text style={sa.td} numberOfLines={2}>{b.name}</Text>
                      {b.establishment_name && b.establishment_name !== b.name ? (
                        <Text style={sa.tdMuted} numberOfLines={1}>{b.establishment_name}</Text>
                      ) : null}
                      <Text style={sa.tdMuted} numberOfLines={1}>
                        {b.order_count} order{b.order_count === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Text
                      style={[sa.tdMuted, { width: COLS.gstin, paddingRight: SPACING.xs }]}
                      numberOfLines={2}
                    >
                      {/* A B2C business has no GSTIN, which is the answer
                          rather than a gap -- the TYPE column beside it says
                          why the cell is empty. */}
                      {b.gst_number || '—'}
                    </Text>
                    <View style={{ width: COLS.type }}>
                      <View style={[sa.pill, { backgroundColor: COLORS.Background }]}>
                        <Text style={[sa.pillText, { color: COLORS.Primary }]}>
                          {b.registration_type || 'B2B'}
                        </Text>
                      </View>
                    </View>
                    <Text
                      style={[sa.tdMuted, { width: COLS.billing, paddingRight: SPACING.xs }]}
                      numberOfLines={1}
                    >
                      {b.billing_cycle
                        ? b.billing_cycle.charAt(0) +
                          b.billing_cycle.slice(1).toLowerCase().replace('_', '-')
                        : '—'}
                    </Text>
                    <View style={{ width: COLS.status }}>
                      <StatusPill status={b.status} />
                    </View>
                    <View
                      style={{
                        width: COLS.actions,
                        flexDirection: 'row',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: SPACING.xs,
                      }}
                    >
                      <ActionButton
                        icon="eye-outline"
                        label="View"
                        onPress={() =>
                          navigation.navigate('SuperAdminBusinessDetails', { businessId: b.id })
                        }
                        accessibilityLabel={`View ${b.name}`}
                      />
                      {/* The FULL registration-style form, not a cut-down one. */}
                      <ActionButton
                        icon="create-outline"
                        label="Edit"
                        tone="primary"
                        onPress={() =>
                          navigation.navigate('SuperAdminEditBusiness', { businessId: b.id })
                        }
                        accessibilityLabel={`Edit ${b.name}`}
                      />
                      {/* A reset, never a retrieval: the existing password
                          cannot be shown because only its hash was stored. */}
                      <ActionButton
                        icon="key-outline"
                        label="Password"
                        onPress={() => setPasswordFor(b)}
                        accessibilityLabel={`Change the password for ${b.name}`}
                      />
                      <ActionButton
                        icon={
                          b.status === 'ACTIVE'
                            ? 'close-circle-outline'
                            : 'checkmark-circle-outline'
                        }
                        label={b.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                        onPress={() => toggleActive(b)}
                        accessibilityLabel={
                          b.status === 'ACTIVE' ? `Disable ${b.name}` : `Enable ${b.name}`
                        }
                      />
                      <ActionButton
                        icon="trash-outline"
                        label="Delete"
                        tone="danger"
                        onPress={() => confirmDelete(b)}
                        accessibilityLabel={`Delete ${b.name}`}
                      />
                    </View>
                  </View>
                ))}
              </View>
            </ScrollView>
          )}

          <Text style={[sa.cardMeta, { marginTop: SPACING.md }]}>
            A disabled business cannot sign in, cannot place orders and cannot open its home
            screen. Its past orders and invoices stay available here.
          </Text>
        </ScrollView>
      )}

      <BusinessPasswordModal
        business={passwordFor}
        onClose={() => setPasswordFor(null)}
        onSaved={() => { setPasswordFor(null); load(); }}
      />
    </SafeAreaView>
  );
}

/**
 * Set a new password on a business's login account.
 *
 * A RESET, NOT A RETRIEVAL. The current password cannot be displayed because
 * only its hash was ever stored, and the API never returns one. The Super
 * Admin types a new password, the server hashes it into the same
 * `business_users.password_hash` the business login already reads, and the
 * business signs in afterwards through exactly the path it did before.
 *
 * The typed value lives in this component's state only while the sheet is
 * open, and is cleared as soon as the request returns.
 */
function BusinessPasswordModal({
  business, onClose, onSaved,
}: { business: BusinessAdmin | null; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    setPassword(''); setConfirm(''); setError('');
  }, [business]);

  const save = async () => {
    if (!business) return;
    // The same rules the server enforces, checked here so the answer is
    // immediate. The server is what decides.
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      const result = await superAdminApi.setBusinessPassword(business.id, {
        password, confirm_password: confirm,
      });
      setPassword(''); setConfirm('');
      Alert.alert('Password updated', result.message);
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not set the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={business !== null} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>Change business password</Text>
            <TouchableOpacity style={sa.iconBtn} onPress={onClose} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={COLORS.TextPrimary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
            {!!error && (
              <View style={sa.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                <Text style={sa.errorText}>{error}</Text>
              </View>
            )}

            <View style={sa.card}>
              <Text style={sa.cardTitle}>{business?.name || 'Business'}</Text>
              <Text style={sa.cardMeta}>
                The current password stops working immediately. It cannot be shown — only its
                hash was stored. The new one is emailed to the business.
              </Text>
            </View>

            <PasswordFields
              password={password}
              confirm={confirm}
              onChangePassword={setPassword}
              onChangeConfirm={setConfirm}
              label="NEW PASSWORD"
              username={business?.account_email || undefined}
            />

            <TouchableOpacity
              style={[
                sa.button,
                (busy || passwordProblem(password, confirm) !== null) && sa.buttonDisabled,
              ]}
              onPress={save}
              disabled={busy || passwordProblem(password, confirm) !== null}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.Surface} />
              ) : (
                <Text style={sa.buttonText}>Set password and email it</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={sa.buttonGhost} onPress={onClose}>
              <Text style={sa.buttonGhostText}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ height: SPACING.xxl }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.INACTIVE;
  return (
    <View style={[sa.pill, { backgroundColor: tone.bg }]}>
      <Text style={[sa.pillText, { color: tone.fg }]}>{status}</Text>
    </View>
  );
}
