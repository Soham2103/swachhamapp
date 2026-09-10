import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import ticketApi, {
  TicketDetail, TicketStatus, TicketMeta, PRIORITY_LABELS,
} from '../../services/ticketApi';
import { extractErrorMessage } from '../../services/api';

/**
 * ONE TICKET: its detail, its whole conversation, and its history.
 *
 * WHAT IS OFFERED DEPENDS ON WHO IS LOOKING, and the answer comes from the
 * server rather than from a role check written here. The status and assignment
 * controls are shown only when the caller may use them — worked out from the
 * ticket's own creator role and the caller's role in `canResolve` below, the
 * same rule the service enforces. A creator who somehow reached the control
 * would still be refused by the API; this only decides what to draw.
 *
 * REPLYING IS NOT RESOLVING. Both sides of a ticket may reply, and only a
 * resolver may change its status. That is why the composer is always present
 * and the status row is not.
 */

const STATUS_TONE: Record<TicketStatus, { bg: string; fg: string }> = {
  OPEN: { bg: '#FDECEC', fg: '#B42318' },
  IN_PROGRESS: { bg: '#FFF4E5', fg: '#8A5200' },
  WAITING_FOR_RESPONSE: { bg: '#EEF2FF', fg: '#3538CD' },
  RESOLVED: { bg: '#E8F3EC', fg: '#1B4332' },
  CLOSED: { bg: '#F1F3F5', fg: '#5B6470' },
};

const NEXT_STATUSES: TicketStatus[] = [
  'IN_PROGRESS', 'WAITING_FOR_RESPONSE', 'RESOLVED', 'CLOSED', 'OPEN',
];

function when(value: string) {
  const d = new Date(value);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} ` +
    `${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

export default function TicketDetailScreen({ navigation, route }: any) {
  const { ticketId } = route.params || {};
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [meta, setMeta] = useState<TicketMeta | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assignees, setAssignees] = useState<Array<{ id: string; name: string; role: string }>>([]);

  const load = useCallback(async () => {
    try {
      setError('');
      const [detail, m] = await Promise.all([
        ticketApi.get(String(ticketId)),
        meta ? Promise.resolve({ data: meta } as any) : ticketApi.meta(),
      ]);
      setTicket(detail.data);
      if (!meta) setMeta(m.data);
    } catch (e: any) {
      setError(extractErrorMessage(e, 'Could not load this ticket'));
    } finally {
      setLoading(false);
    }
  }, [ticketId, meta]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /**
   * May this viewer resolve THIS ticket?
   *
   * The same rule the server holds: a hotel's ticket is answered by a Manager
   * or the Super Admin, and everything else by the Super Admin alone.
   */
  const canResolve = Boolean(
    ticket && meta &&
    (ticket.created_by_role === 'BUSINESS'
      ? meta.role === 'MANAGER' || meta.role === 'SUPER_ADMIN'
      : meta.role === 'SUPER_ADMIN')
  );

  const send = async () => {
    if (!message.trim() || busy || !ticket) return;
    setBusy(true);
    setError('');
    try {
      const res = await ticketApi.reply(ticket.id, message.trim());
      setTicket(res.data);
      setMessage('');
    } catch (e: any) {
      setError(extractErrorMessage(e, 'Could not send the reply'));
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = (next: TicketStatus) => {
    if (!ticket || busy) return;
    Alert.alert(
      meta?.status_labels?.[next] || next,
      `Set ${ticket.ticket_number} to ${meta?.status_labels?.[next] || next}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setBusy(true);
            setError('');
            try {
              const res = await ticketApi.setStatus(ticket.id, next);
              setTicket(res.data);
            } catch (e: any) {
              setError(extractErrorMessage(e, 'Could not change the status'));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const pickAssignee = async () => {
    if (!ticket || busy) return;
    try {
      const list = assignees.length
        ? assignees
        : (await ticketApi.assignable(ticket.id)).data;
      setAssignees(list);
      Alert.alert(
        'Assign ticket',
        `Who should answer ${ticket.ticket_number}?`,
        [
          ...list.slice(0, 8).map((person) => ({
            text: `${person.name} (${person.role})`,
            onPress: async () => {
              setBusy(true);
              try {
                const res = await ticketApi.assign(ticket.id, person.id);
                setTicket(res.data);
              } catch (e: any) {
                setError(extractErrorMessage(e, 'Could not assign the ticket'));
              } finally {
                setBusy(false);
              }
            },
          })),
          { text: 'Cancel', style: 'cancel' as const },
        ]
      );
    } catch (e: any) {
      setError(extractErrorMessage(e, 'Could not load the resolvers'));
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!ticket) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header onBack={() => navigation.goBack()} title="Ticket" />
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error || 'Ticket not found'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const tone = STATUS_TONE[ticket.status] || STATUS_TONE.OPEN;
  const closed = ticket.status === 'CLOSED';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header onBack={() => navigation.goBack()} title={ticket.ticket_number} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {!!error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.category}>{ticket.category_label}</Text>
              <View style={[styles.statusPill, { backgroundColor: tone.bg }]}>
                <Text style={[styles.statusText, { color: tone.fg }]}>{ticket.status_label}</Text>
              </View>
            </View>

            <Text style={styles.title}>{ticket.title}</Text>
            <Text style={styles.description}>{ticket.description}</Text>

            <View style={styles.divider} />

            <Row label="Priority" value={PRIORITY_LABELS[ticket.priority]} />
            <Row
              label="Raised by"
              value={`${ticket.created_by_name} (${ticket.created_by_role})`}
            />
            <Row label="Raised on" value={when(ticket.created_at)} />
            {ticket.business_name ? <Row label="Establishment" value={ticket.business_name} /> : null}
            {ticket.order_number ? <Row label="Order" value={ticket.order_number} /> : null}
            <Row label="Assigned to" value={ticket.assigned_to_name || 'Unassigned'} />
            {ticket.resolved_at ? <Row label="Resolved" value={when(ticket.resolved_at)} /> : null}
            {ticket.closed_at ? <Row label="Closed" value={when(ticket.closed_at)} /> : null}
          </View>

          {/* THE RESOLVER'S CONTROLS. Drawn only for someone who may use them;
              the server refuses anyone else regardless. */}
          {canResolve ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Manage</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {NEXT_STATUSES.filter((s) => s !== ticket.status).map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[styles.chip, busy && styles.disabled]}
                    onPress={() => changeStatus(s)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Set status to ${meta?.status_labels?.[s] || s}`}
                  >
                    <Text style={styles.chipText}>{meta?.status_labels?.[s] || s}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={[styles.assignBtn, busy && styles.disabled]}
                onPress={pickAssignee}
                disabled={busy}
                accessibilityRole="button"
              >
                <Ionicons name="person-add-outline" size={16} color={COLORS.Primary} />
                <Text style={styles.assignText}>
                  {ticket.assigned_to_name ? 'REASSIGN' : 'ASSIGN'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Conversation ({ticket.messages.length})</Text>
            {ticket.messages.length === 0 ? (
              <Text style={styles.meta}>No replies yet.</Text>
            ) : (
              ticket.messages.map((m) => (
                <View key={m.id} style={styles.message}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.sender}>{m.sender_name} ({m.sender_role})</Text>
                    <Text style={styles.meta}>{when(m.created_at)}</Text>
                  </View>
                  <Text style={styles.messageText}>{m.message}</Text>
                </View>
              ))
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>History</Text>
            {ticket.history.map((h) => (
              <Text key={h.id} style={styles.historyLine}>
                {when(h.created_at)} · {h.previous_status ? `${h.previous_status} → ` : ''}
                {h.new_status} · {h.changed_by_name} ({h.changed_by_role})
                {h.note ? ` · ${h.note}` : ''}
              </Text>
            ))}
          </View>
        </ScrollView>

        {/* Both sides reply. A closed ticket takes no more messages until it is
            reopened by someone entitled to reopen it. */}
        {closed ? (
          <View style={styles.closedBar}>
            <Ionicons name="lock-closed-outline" size={14} color={COLORS.TextSecondary} />
            <Text style={styles.meta}>This ticket is closed.</Text>
          </View>
        ) : (
          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={message}
              onChangeText={setMessage}
              placeholder="Write a reply…"
              placeholderTextColor={COLORS.TextSecondary}
              multiline
              maxLength={5000}
              editable={!busy}
              accessibilityLabel="Reply message"
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!message.trim() || busy) && styles.disabled]}
              onPress={send}
              disabled={!message.trim() || busy}
              accessibilityRole="button"
              accessibilityLabel="Send reply"
            >
              {busy ? (
                <ActivityIndicator size="small" color={COLORS.Surface} />
              ) : (
                <Ionicons name="send" size={18} color={COLORS.Surface} />
              )}
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.iconBtn} onPress={onBack} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingHorizontal: SPACING.sm, paddingVertical: SPACING.sm,
    backgroundColor: COLORS.Surface, borderBottomWidth: 1, borderBottomColor: COLORS.Border,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold', color: COLORS.TextPrimary,
  },
  iconBtn: { padding: SPACING.xs },
  scroll: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xl },

  card: {
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, gap: 6, ...SHADOWS.light,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold', color: COLORS.TextPrimary, marginBottom: 2,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  category: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700', color: COLORS.Primary,
  },
  statusPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: BORDER_RADIUS.full },
  statusText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, fontWeight: '800' },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  description: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary, lineHeight: 20,
  },
  divider: { height: 1, backgroundColor: COLORS.Border, marginVertical: SPACING.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.md, paddingVertical: 3 },
  rowLabel: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary,
  },
  rowValue: {
    flex: 1, textAlign: 'right', fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm, fontWeight: '600', color: COLORS.TextPrimary,
  },

  chipRow: { gap: SPACING.xs, paddingVertical: 2 },
  chip: {
    paddingHorizontal: SPACING.md, paddingVertical: 8, borderRadius: BORDER_RADIUS.full,
    borderWidth: 1, borderColor: COLORS.Border, backgroundColor: COLORS.Surface,
  },
  chipText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  assignBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 40, marginTop: SPACING.xs, borderRadius: BORDER_RADIUS.md,
    borderWidth: 1, borderColor: COLORS.Primary,
  },
  assignText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800', color: COLORS.Primary, letterSpacing: 0.4,
  },

  message: {
    borderTopWidth: 1, borderTopColor: COLORS.Border,
    paddingTop: SPACING.xs, marginTop: SPACING.xs, gap: 2,
  },
  sender: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  messageText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary, lineHeight: 19,
  },
  meta: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary,
  },
  historyLine: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary, lineHeight: 18,
  },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.xs,
    padding: SPACING.sm, backgroundColor: COLORS.Surface,
    borderTopWidth: 1, borderTopColor: COLORS.Border,
  },
  composerInput: {
    flex: 1, maxHeight: 110, minHeight: 40,
    borderWidth: 1, borderColor: COLORS.Border, borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs,
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextPrimary,
  },
  sendBtn: {
    width: 44, height: 40, borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary, alignItems: 'center', justifyContent: 'center',
  },
  closedBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: SPACING.md, backgroundColor: COLORS.Surface,
    borderTopWidth: 1, borderTopColor: COLORS.Border,
  },
  disabled: { opacity: 0.5 },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    padding: SPACING.sm, backgroundColor: '#FDECEC', borderRadius: BORDER_RADIUS.sm,
  },
  errorText: {
    flex: 1, fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.Error,
  },
});
