import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { sa, STATUS_TONE } from './styles';
import superAdminApi, { CreationRequest, RequestType } from '../../services/superAdminApi';
import PasswordFields, { passwordProblem } from './PasswordFields';

/**
 * Business / Rider / Sorter Requests — the Super Admin's approval queue.
 *
 * ONE SCREEN, THREE TABS. The three request kinds are reviewed the same way,
 * so they share a queue rather than being three near-identical screens; the
 * tab is a filter, and the route can open on any of them.
 *
 * APPROVING IS WHERE THE PASSWORD IS SET. The Super Admin types the initial
 * password in the approval sheet; the server validates and hashes it, creates
 * the account, and emails that exact password to the account holder. Nothing
 * is generated anywhere.
 *
 * The typed password lives in this screen's state only while the sheet is
 * open and is cleared as soon as the request settles. The API never returns
 * one — when an email fails the answer is Resend, which takes a FRESH
 * password, because the old one was never stored.
 */

const TABS: Array<{ value: RequestType; label: string }> = [
  { value: 'BUSINESS', label: 'Business' },
  { value: 'RIDER', label: 'Rider' },
  { value: 'SORTER', label: 'Sorter' },
];

export default function SuperAdminRequestsScreen({ navigation, route }: any) {
  const [tab, setTab] = useState<RequestType>(route?.params?.type ?? 'BUSINESS');
  const [showDecided, setShowDecided] = useState(false);
  const [rows, setRows] = useState<CreationRequest[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await superAdminApi.getRequests());
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const forTab = useMemo(() => rows.filter((r) => r.request_type === tab), [rows, tab]);
  const shown = useMemo(
    () => (showDecided ? forTab : forTab.filter((r) => r.status === 'PENDING')),
    [forTab, showDecided]
  );
  const pendingCount = (type: RequestType) =>
    rows.filter((r) => r.request_type === type && r.status === 'PENDING').length;

  /**
   * Approving needs a password, so it opens a sheet rather than a confirm
   * dialog. `mode` says whether the sheet is creating the account or
   * re-issuing credentials for one that already exists.
   */
  const [credentialFor, setCredentialFor] =
    useState<{ request: CreationRequest; mode: 'APPROVE' | 'RESEND' } | null>(null);

  const confirmReject = (r: CreationRequest) => {
    Alert.alert(
      'Reject this request?',
      `${r.subject_name}\n\nNo account is created. The Manager sees the rejection.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setBusyId(r.id);
            try {
              await superAdminApi.rejectRequest(r.id, 'Rejected by Super Admin');
              load();
            } catch (e: any) {
              Alert.alert('Could not reject', e?.response?.data?.message || e.message);
            } finally {
              setBusyId(null);
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
        <Text style={sa.headerTitle}>Requests</Text>
      </View>

      <View style={sa.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.value}
            style={[sa.tab, tab === t.value && sa.tabActive]}
            onPress={() => setTab(t.value)}
          >
            <Text style={[sa.tabText, tab === t.value && sa.tabTextActive]}>
              {t.label} ({pendingCount(t.value)})
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={{ paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm }}
        onPress={() => setShowDecided((v) => !v)}
      >
        <Text style={{
          fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
          color: COLORS.Primary, fontWeight: '600',
        }}>
          {showDecided ? 'Show pending only' : 'Show approved and rejected too'}
        </Text>
      </TouchableOpacity>

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
              {showDecided ? 'No requests of this kind.' : 'Nothing waiting for a decision.'}
            </Text>
          )}

          {shown.map((r) => {
            const open = expanded === r.id;
            const working = busyId === r.id;
            return (
              <View key={r.id} style={sa.card}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => setExpanded(open ? null : r.id)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                    <View style={sa.flex}>
                      <Text style={sa.cardTitle}>{r.subject_name}</Text>
                      {r.request_type === 'BUSINESS' ? (
                        <Text style={sa.cardMeta}>
                          {/* A B2C request has no GSTIN, so the line says the
                              registration type rather than "GST" followed by
                              a blank. */}
                          {r.payload?.gstin
                            ? `${r.payload.registration_type || 'B2B'} · GST ${r.payload.gstin}`
                            : `${r.payload?.registration_type || 'B2C'} · no GST`}
                          {' · '}
                          {r.payload?.billing_cycle}
                        </Text>
                      ) : null}
                      <Text style={sa.cardMeta}>
                        {r.subject_email} · by {r.requested_by_name || 'Manager'} ·{' '}
                        {new Date(r.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Pill status={r.status} />
                  </View>
                </TouchableOpacity>

                {/* The account exists but nobody has the password. Surfaced
                    prominently, because it is the one state that needs an
                    action after approval. */}
                {r.status === 'APPROVED' && r.email_status === 'FAILED' && (
                  <View style={[sa.warnBox, { marginTop: SPACING.sm, marginBottom: 0 }]}>
                    <Ionicons name="mail-unread-outline" size={16} color="#8A5200" />
                    <Text style={sa.warnText}>
                      The account was created but the credentials email failed. Use Resend.
                    </Text>
                  </View>
                )}

                {open && (
                  <View style={{ marginTop: SPACING.sm }}>
                    {r.request_type === 'BUSINESS' ? (
                      <>
                        <Row label="Registration type" value={r.payload?.registration_type} />
                        {/* Both rows render nothing when the value is absent,
                            which is exactly right for a B2C request. */}
                        <Row label="GST number" value={r.payload?.gstin} />
                        <Row label="PAN" value={r.payload?.pan_number} />
                        <Row label="Legal name" value={r.payload?.legal_name} />
                        <Row label="Legal address" value={r.payload?.legal_address} />
                        <Row label="Billing cycle" value={r.payload?.billing_cycle} />
                        <Row label="City / State" value={[r.payload?.city, r.payload?.state].filter(Boolean).join(', ')} />
                        <Text style={[sa.label, { marginTop: SPACING.sm }]}>BUSINESS HEAD</Text>
                        <Row label="Name" value={r.payload?.business_head?.name} />
                        <Row label="Designation" value={r.payload?.business_head?.designation} />
                        <Row label="Mobile" value={r.payload?.business_head?.mobile} />
                        <Row label="WhatsApp" value={r.payload?.business_head?.whatsapp} />
                        <Row label="Email (username)" value={r.payload?.business_head?.email} />
                        <Text style={[sa.label, { marginTop: SPACING.sm }]}>
                          ALTERNATIVE CONTACTS
                        </Text>
                        {(r.payload?.alternative_contacts || []).map((c: any, i: number) => (
                          <Row key={i} label={`${i + 1}. ${c.name}`} value={`${c.mobile} · ${c.email}`} />
                        ))}
                      </>
                    ) : (
                      <>
                        <Row label="Email (username)" value={r.payload?.email} />
                        <Row label="Mobile" value={r.payload?.mobile_number} />
                      </>
                    )}
                  </View>
                )}

                {r.status === 'PENDING' ? (
                  <View style={sa.rowBtns}>
                    <TouchableOpacity
                      style={[sa.approve, working && sa.buttonDisabled]}
                      onPress={() => setCredentialFor({ request: r, mode: 'APPROVE' })}
                      disabled={working}
                    >
                      {working ? (
                        <ActivityIndicator size="small" color={COLORS.Surface} />
                      ) : (
                        <Text style={sa.approveText}>Approve</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[sa.reject, working && sa.buttonDisabled]}
                      onPress={() => confirmReject(r)}
                      disabled={working}
                    >
                      <Text style={sa.rejectText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                ) : r.status === 'APPROVED' ? (
                  <TouchableOpacity
                    style={[sa.buttonGhost, working && sa.buttonDisabled]}
                    onPress={() => setCredentialFor({ request: r, mode: 'RESEND' })}
                    disabled={working}
                  >
                    <Text style={sa.buttonGhostText}>Set new password and resend</Text>
                  </TouchableOpacity>
                ) : null}

                <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
                  {open ? 'Tap the header to collapse' : 'Tap the header for full details'}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      )}

      <CredentialSheet
        target={credentialFor}
        onClose={() => setCredentialFor(null)}
        onDone={() => { setCredentialFor(null); load(); }}
      />
    </SafeAreaView>
  );
}

/**
 * The approval sheet: the submission's identity, then the password.
 *
 * Used for both approving (which creates the account) and re-issuing after a
 * failed email. The username is fixed — it is the account's email — so it is
 * displayed, not offered as a field.
 */
function CredentialSheet({
  target, onClose, onDone,
}: {
  target: { request: CreationRequest; mode: 'APPROVE' | 'RESEND' } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Cleared whenever the sheet opens or closes, so a typed password never
  // survives into the next one.
  React.useEffect(() => {
    setPassword(''); setConfirm(''); setError('');
  }, [target]);

  const request = target?.request;
  const approving = target?.mode === 'APPROVE';

  const kindLabel =
    request?.request_type === 'BUSINESS' ? 'Business User'
      : request?.request_type === 'RIDER' ? 'Rider' : 'Sorter';

  const submit = async () => {
    if (!request) return;
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }

    setBusy(true);
    setError('');
    try {
      if (approving) {
        const result = await superAdminApi.approveRequest(request.id, {
          password, confirm_password: confirm,
        });
        setPassword(''); setConfirm('');
        // "Approved" and "approved but the email failed" are different
        // outcomes; the second still created the account.
        Alert.alert(
          result.data.email.sent ? 'Approved' : 'Approved — email failed',
          result.message
        );
      } else {
        const result = await superAdminApi.resendCredentials(request.id, {
          password, confirm_password: confirm,
        });
        setPassword(''); setConfirm('');
        Alert.alert('Credentials', result.message);
      }
      onDone();
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not complete that.');
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || passwordProblem(password, confirm) !== null;

  return (
    <Modal visible={target !== null} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>
              {approving ? `Approve ${kindLabel}` : 'Set new password'}
            </Text>
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

            {/* What is being approved, so the decision is made against the
                submission rather than from memory. */}
            <View style={sa.card}>
              <Text style={sa.cardTitle}>{request?.subject_name}</Text>
              {request?.request_type === 'BUSINESS' ? (
                <>
                  <Row label="Registration type" value={request?.payload?.registration_type} />
                  <Row label="GST number" value={request?.payload?.gstin} />
                  <Row label="PAN" value={request?.payload?.pan_number} />
                  <Row label="Billing cycle" value={request?.payload?.billing_cycle} />
                  <Row label="Business head" value={request?.payload?.business_head?.name} />
                  <Row label="Mobile" value={request?.payload?.business_head?.mobile} />
                </>
              ) : (
                <>
                  <Row label="Mobile" value={request?.payload?.mobile_number} />
                </>
              )}
              <Row label="Submitted by" value={request?.requested_by_name} />
            </View>

            <Text style={[sa.label, { marginTop: 0 }]}>
              {kindLabel.toUpperCase()} ACCOUNT
            </Text>

            <PasswordFields
              password={password}
              confirm={confirm}
              onChangePassword={setPassword}
              onChangeConfirm={setConfirm}
              label={approving ? 'PASSWORD' : 'NEW PASSWORD'}
              username={request?.subject_email || undefined}
            />

            <TouchableOpacity
              style={[sa.button, blocked && sa.buttonDisabled]}
              onPress={submit}
              disabled={blocked}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.Surface} />
              ) : (
                <Text style={sa.buttonText}>
                  {approving ? 'Approve & Create Account' : 'Set password and email it'}
                </Text>
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

function Pill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.INACTIVE;
  return (
    <View style={[sa.pill, { backgroundColor: tone.bg, marginTop: 0 }]}>
      <Text style={[sa.pillText, { color: tone.fg }]}>{status}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', gap: SPACING.sm, paddingVertical: 2 }}>
      <Text style={{
        fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
        color: COLORS.TextSecondary, width: 130,
      }}>
        {label}
      </Text>
      <Text style={{
        flex: 1, fontFamily: TYPOGRAPHY.fontFamily,
        fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextPrimary,
      }}>
        {value}
      </Text>
    </View>
  );
}
