import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import businessDoorApi, { DoorTicket, BusinessMessage } from '../../services/businessDoorApi';
import { extractErrorMessage } from '../../services/api';

/**
 * PICKUP APPROVALS — the business's answer to a rider at the door.
 *
 * ============================================================
 * WHY THIS SCREEN IS NOT AN INBOX
 * ============================================================
 *
 * A rider who takes a load WITHOUT counting it raises a ticket and then
 * STANDS THERE. Nothing moves until this screen's Accept is tapped. So the
 * tickets are first, they are loud, and the messages — which are a record of
 * what has already happened — sit underneath them.
 *
 * ============================================================
 * WHY IT POLLS
 * ============================================================
 *
 * The app has no socket client (`socket.io-client` is not a dependency), so a
 * server-side emit reaches nothing. A ticket raised while this screen is open
 * would otherwise never appear. Refreshing on focus covers the ordinary case;
 * the 10-second poll covers the one that matters, which is a rider raising a
 * ticket while somebody is already looking at this screen.
 */
export default function BusinessDoorTicketsScreen() {
  const navigation = useNavigation<any>();

  const [tickets, setTickets] = useState<DoorTicket[]>([]);
  const [messages, setMessages] = useState<BusinessMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Ticket id currently being accepted, so only its own button spins. */
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const load = useCallback(async (refreshing = false) => {
    if (refreshing) setIsRefreshing(true);
    try {
      const [ticketResponse, messageResponse] = await Promise.all([
        businessDoorApi.getPendingTickets(),
        businessDoorApi.getMessages(),
      ]);
      setTickets(ticketResponse.data || []);
      setMessages(messageResponse.data || []);
      setError(null);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not load pickup approvals.'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();

      // See the header note: a rider can raise a ticket while this screen is
      // already open, and nothing would push it here.
      const timer = setInterval(() => void load(), 10000);
      return () => clearInterval(timer);
    }, [load])
  );

  /**
   * Accept a ticket.
   *
   * Confirmed first because this is not an acknowledgement — it releases a
   * rider to leave with a load nobody counted, and sends them a notice saying
   * so. That is a commitment, not a dismissal.
   */
  const handleAccept = (ticket: DoorTicket) => {
    Alert.alert(
      'Accept this pickup?',
      `The rider did not count order ${ticket.order_number || ticket.order_id} at the door. ` +
        'Accepting releases them to continue, and they will be told that any mismatch is ' +
        'communicated and physical verification is done at Swachham.',
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Accept',
          onPress: async () => {
            setAcceptingId(ticket.ticket_id);
            try {
              await businessDoorApi.acceptTicket(ticket.ticket_id);
              // Drop it immediately, then reconcile with the server.
              setTickets((current) =>
                current.filter((t) => t.ticket_id !== ticket.ticket_id)
              );
              await load();
            } catch (err: any) {
              Alert.alert(
                'Could not accept',
                extractErrorMessage(err, 'The ticket could not be accepted.')
              );
            } finally {
              setAcceptingId(null);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BusinessHeader title="Pickup Approvals" onBack={() => navigation.goBack()} />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => load(true)}
              tintColor={COLORS.Primary}
            />
          }
        >
          {error ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={18} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* ---------- WAITING ON YOU ---------- */}
          <Text style={styles.sectionTitle}>Waiting on you</Text>

          {tickets.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-circle-outline" size={40} color={COLORS.TextSecondary} />
              <Text style={styles.emptyText}>No pickups are waiting for approval.</Text>
            </View>
          ) : (
            tickets.map((ticket) => (
              <View key={ticket.ticket_id} style={styles.ticketCard}>
                <View style={styles.ticketTop}>
                  <Ionicons name="alert-circle" size={18} color={COLORS.Warning} />
                  <Text style={styles.ticketTitle}>
                    Order {ticket.order_number || ticket.order_id}
                  </Text>
                </View>

                <Text style={styles.ticketBody}>
                  {ticket.rider_name ? `${ticket.rider_name} ` : 'A rider '}
                  collected this without counting it at the door.
                </Text>

                {ticket.address_text ? (
                  <Text style={styles.ticketMeta} numberOfLines={2}>
                    {ticket.address_text}
                  </Text>
                ) : null}

                <Text style={styles.ticketMeta}>
                  {ticket.item_count} {ticket.item_count === 1 ? 'item' : 'items'}
                  {ticket.weight_kg > 0 ? ` · ${ticket.weight_kg} kg` : ''}
                </Text>

                <TouchableOpacity
                  style={[
                    styles.acceptButton,
                    acceptingId === ticket.ticket_id && styles.acceptButtonBusy,
                  ]}
                  onPress={() => handleAccept(ticket)}
                  disabled={acceptingId === ticket.ticket_id}
                  activeOpacity={0.85}
                >
                  {acceptingId === ticket.ticket_id ? (
                    <ActivityIndicator size="small" color={COLORS.Surface} />
                  ) : (
                    <Text style={styles.acceptButtonText}>Accept</Text>
                  )}
                </TouchableOpacity>
              </View>
            ))
          )}

          {/* ---------- FROM YOUR RIDERS ---------- */}
          <Text style={styles.sectionTitle}>From your riders</Text>

          {messages.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="chatbubble-outline" size={40} color={COLORS.TextSecondary} />
              <Text style={styles.emptyText}>No messages yet.</Text>
            </View>
          ) : (
            messages.map((message) => (
              <View key={message.id} style={styles.messageCard}>
                <Text style={styles.messageBody}>{message.body}</Text>
                {message.order_number ? (
                  <Text style={styles.messageMeta}>Order {message.order_number}</Text>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.Surface,
    borderWidth: 1,
    borderColor: COLORS.Error,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    marginBottom: SPACING.md,
  },
  errorText: { flex: 1, color: COLORS.Error, fontSize: TYPOGRAPHY.sizes.sm },

  sectionTitle: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: TYPOGRAPHY.weights.semibold,
    color: COLORS.TextPrimary,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },

  empty: {
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    gap: SPACING.sm,
  },
  emptyText: {
    color: COLORS.TextSecondary,
    fontSize: TYPOGRAPHY.sizes.sm,
    textAlign: 'center',
  },

  ticketCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Warning,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    ...SHADOWS.light,
  },
  ticketTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  ticketTitle: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: TYPOGRAPHY.weights.semibold,
    color: COLORS.TextPrimary,
  },
  ticketBody: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
    lineHeight: 20,
  },
  ticketMeta: {
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  acceptButton: {
    backgroundColor: COLORS.Primary,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm + 2,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  acceptButtonBusy: { opacity: 0.7 },
  acceptButtonText: {
    color: COLORS.Surface,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: TYPOGRAPHY.weights.semibold,
  },

  messageCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  messageBody: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
    lineHeight: 20,
  },
  messageMeta: {
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: SPACING.xs,
  },
});
