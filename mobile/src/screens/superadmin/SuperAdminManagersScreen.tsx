import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  TextInput, Modal, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { sa, STATUS_TONE } from './styles';
import superAdminApi, { ManagerAccount } from '../../services/superAdminApi';
import PasswordFields, { passwordProblem } from './PasswordFields';

/**
 * Manager accounts.
 *
 * THE ONLY PLACE A MANAGER IS CREATED. There is no self-registration and no
 * Manager-creates-Manager path — the endpoint behind this screen is Super
 * Admin only, and it is the sole way a MANAGER row comes into existence.
 *
 * THE SUPER ADMIN TYPES THE PASSWORD. Nothing is generated: the password
 * entered here is the one hashed into the account and the one emailed to the
 * Manager. It lives in this screen's state only while the sheet is open and
 * is cleared the moment the request returns — it is never persisted and the
 * API never sends it back.
 *
 * If the email does not arrive, the answer is Reset password, which takes a
 * FRESH password. The existing one cannot be shown because only its hash was
 * ever stored.
 */
export default function SuperAdminManagersScreen({ navigation }: any) {
  const [rows, setRows] = useState<ManagerAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await superAdminApi.getManagers());
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load managers');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggleActive = async (m: ManagerAccount) => {
    try {
      await superAdminApi.setManagerActive(m.id, !m.is_active);
      load();
    } catch (e: any) {
      Alert.alert('Could not update', e?.response?.data?.message || e.message);
    }
  };

  /** The manager whose password is being reset, if any. */
  const [resetting, setResetting] = useState<ManagerAccount | null>(null);

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>Managers</Text>
        <TouchableOpacity style={sa.iconBtn} onPress={() => setAdding(true)} accessibilityLabel="Add manager">
          <Ionicons name="add-circle" size={26} color={COLORS.Primary} />
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

          {rows.length === 0 && (
            <Text style={sa.empty}>No managers yet. Use + to create one.</Text>
          )}

          {rows.map((m) => {
            const tone = m.is_active ? STATUS_TONE.ACTIVE : STATUS_TONE.INACTIVE;
            return (
              <View key={m.id} style={sa.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                  <View style={sa.flex}>
                    <Text style={sa.cardTitle}>{m.name || '—'}</Text>
                    <Text style={sa.cardMeta}>{m.email}</Text>
                    <Text style={sa.cardMeta}>{m.mobile_number}</Text>
                    <Text style={sa.cardMeta}>
                      {m.pending} pending · {m.approved} approved · {m.rejected} rejected
                    </Text>
                  </View>
                  <View style={[sa.pill, { backgroundColor: tone.bg, marginTop: 0 }]}>
                    <Text style={[sa.pillText, { color: tone.fg }]}>
                      {m.is_active ? 'ACTIVE' : 'DISABLED'}
                    </Text>
                  </View>
                </View>

                <View style={sa.rowBtns}>
                  <TouchableOpacity
                    style={[sa.approve, !m.is_active && { backgroundColor: COLORS.TextSecondary }]}
                    onPress={() => toggleActive(m)}
                  >
                    <Text style={sa.approveText}>{m.is_active ? 'Disable' : 'Enable'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={sa.reject} onPress={() => setResetting(m)}>
                    <Text style={sa.rejectText}>Set new password</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <AddManagerModal
        visible={adding}
        onClose={() => setAdding(false)}
        onSaved={() => { setAdding(false); load(); }}
      />

      <ResetPasswordModal
        manager={resetting}
        onClose={() => setResetting(null)}
        onSaved={() => setResetting(null)}
      />
    </SafeAreaView>
  );
}

/**
 * The create form.
 *
 * The Super Admin sets the initial password here. The email doubles as the
 * username, so it is what the password is shown against.
 */
function AddManagerModal({
  visible, onClose, onSaved,
}: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Cleared on every open AND on every close, so a typed password never
  // outlives the sheet it was typed in.
  React.useEffect(() => {
    setName(''); setEmail(''); setMobile('');
    setPassword(''); setConfirm(''); setError('');
  }, [visible]);

  const save = async () => {
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      const result = await superAdminApi.createManager({
        name, email, mobile_number: mobile,
        password, confirm_password: confirm,
      });
      // Dropped from state the moment the request settles.
      setPassword(''); setConfirm('');
      Alert.alert('Manager created', result.message);
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not create the manager');
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    name.trim() !== '' && email.trim() !== '' && mobile.trim().length === 10 &&
    passwordProblem(password, confirm) === null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>New Manager</Text>
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

            <Text style={sa.label}>NAME <Text style={sa.required}>*</Text></Text>
            <TextInput style={sa.input} value={name} onChangeText={setName}
              placeholderTextColor={COLORS.TextSecondary} />

            <Text style={sa.label}>EMAIL <Text style={sa.required}>*</Text></Text>
            <TextInput style={sa.input} value={email} onChangeText={setEmail}
              keyboardType="email-address" autoCapitalize="none"
              placeholder="Becomes the login username"
              placeholderTextColor={COLORS.TextSecondary} />

            <Text style={sa.label}>MOBILE NUMBER <Text style={sa.required}>*</Text></Text>
            <TextInput style={sa.input} value={mobile} onChangeText={setMobile}
              keyboardType="phone-pad" maxLength={10}
              placeholderTextColor={COLORS.TextSecondary} />

            <PasswordFields
              password={password}
              confirm={confirm}
              onChangePassword={setPassword}
              onChangeConfirm={setConfirm}
              username={email || undefined}
            />

            <TouchableOpacity
              style={[sa.button, (!canSave || busy) && sa.buttonDisabled]}
              onPress={save}
              disabled={!canSave || busy}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.Surface} />
              ) : (
                <Text style={sa.buttonText}>Create Manager</Text>
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

/**
 * Set a new password for an existing manager.
 *
 * A reset, not a retrieval: the current password cannot be displayed because
 * only its hash was ever stored. The Super Admin chooses a new one and it is
 * emailed.
 */
function ResetPasswordModal({
  manager, onClose, onSaved,
}: { manager: ManagerAccount | null; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    setPassword(''); setConfirm(''); setError('');
  }, [manager]);

  const save = async () => {
    if (!manager) return;
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      const result = await superAdminApi.resetManagerPassword(manager.id, {
        password, confirm_password: confirm,
      });
      setPassword(''); setConfirm('');
      Alert.alert('Password set', result.message);
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not set the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={manager !== null} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>Set new password</Text>
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
              <Text style={sa.cardTitle}>{manager?.name || 'Manager'}</Text>
              <Text style={sa.cardMeta}>
                The current password stops working immediately. It cannot be shown — only its
                hash was stored.
              </Text>
            </View>

            <PasswordFields
              password={password}
              confirm={confirm}
              onChangePassword={setPassword}
              onChangeConfirm={setConfirm}
              label="NEW PASSWORD"
              username={manager?.email || undefined}
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
