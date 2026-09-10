import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Linking,
  Alert,
  TextInput,
  ActivityIndicator,
} from 'react-native';
// The context package's SafeAreaView — react-native's own is iOS-only and
// applies no inset on Android. See the note in RiderDashboardScreen.
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';

import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import riderApi, { RiderJobDetail, DoorAcceptanceMode } from '../../services/riderApi';
import { extractErrorMessage } from '../../services/api';
import useRiderStore from '../../store/riderStore';
import { canRouteTo, openGoogleMapsRoute } from '../../utils/navigation';

/**
 * One job, worked from accepted to handed over.
 *
 * The screen is a single column of decisions in the order they happen:
 * where am I going, who do I call, what am I collecting, and the one
 * button that is currently possible. Only ONE action is ever offered —
 * a rider on a bike should not have to choose between buttons.
 *
 * The handover code is the last step and it is not optional: the server
 * refuses to complete a job without it, so the field is shown as soon as
 * the rider marks themselves arrived.
 */
export default function RiderJobDetailsScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const jobId = String(route.params?.jobId || '');

  const refreshJobs = useRiderStore((s) => s.refreshJobs);
  const acceptOfferWithCounting = useRiderStore((s) => s.acceptOfferWithCounting);
  const acceptOfferWithoutCounting = useRiderStore((s) => s.acceptOfferWithoutCounting);

  const [job, setJob] = useState<RiderJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  /*
   * THE ACCEPT ORDER STEP.
   *
   * `chosenMode` is null until the rider picks one, which is what keeps
   * Confirm disabled — there is no default, because guessing on the rider's
   * behalf is the thing this step exists to prevent.
   */
  const [chosenMode, setChosenMode] = useState<DoorAcceptanceMode | null>(null);
  const [pieceCount, setPieceCount] = useState('');
  const [accepting, setAccepting] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await riderApi.getJob(jobId);
      setJob(response.data);
      setError(null);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not load this job.'));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  /**
   * Records how this order was accepted, then reloads the job.
   *
   * The reload is what closes the section: the server returns
   * `acceptance_required: false` once a mode is stored, so the screen moves
   * on because the SERVER says the step is done — never because this function
   * assumed it. A failure therefore leaves the section open with the reason
   * on screen, which is the correct outcome.
   *
   * WITHOUT_COUNT does not navigate away. It raises a ticket the business
   * must answer, and the rider stays here with the job in hand.
   */
  const confirmAcceptance = async () => {
    if (!chosenMode || accepting) return;
    setAccepting(true);
    try {
      /*
       * THROUGH THE STORE, not straight to the API.
       *
       * The uncounted path sets `awaitingTicket`, and the dashboard's
       * existing poll and "waiting on the business" card hang off it. Calling
       * the API directly here would record the ticket server-side and leave
       * that machinery blind to it, so the rider would be gated with nothing
       * telling them why.
       */
      const result =
        chosenMode === 'WITH_COUNT'
          ? await acceptOfferWithCounting(jobId, Number(pieceCount))
          : await acceptOfferWithoutCounting(jobId);

      if (!result.ok) {
        Alert.alert('Could not accept', result.message);
        return;
      }
      // Reloaded rather than assumed: the SERVER decides whether the step is
      // done, and `acceptance_required` coming back false is what closes the
      // section.
      await load();
    } catch (err: any) {
      Alert.alert(
        'Could not accept',
        extractErrorMessage(err, 'That did not go through. Try again.')
      );
    } finally {
      setAccepting(false);
    }
  };

  const advance = async (status: 'EN_ROUTE' | 'ARRIVED') => {
    setWorking(true);
    try {
      const response = await riderApi.setJobStatus(jobId, status);
      setJob(response.data);
      await refreshJobs();

      /*
       * SETTING OFF OPENS THE ROUTE IN THE SAME TAP.
       *
       * A rider who has just said "I'm on my way" wants guidance, not a
       * second button to find. Only on EN_ROUTE: re-launching Maps when
       * they mark themselves ARRIVED would fight them at the doorstep.
       *
       * Not awaited into the failure path -- the status change already
       * succeeded, and Maps refusing to open must not report that as an
       * error. The Navigate button is still there if it does not appear.
       */
      if (status === 'EN_ROUTE') {
        // Setting off on a delivery means the rider has LOADED, so the route
        // is now to the customer, not back to the facility.
        void openGoogleMapsRoute({
          latitude: response.data.latitude,
          longitude: response.data.longitude,
          addressText: response.data.address_text,
        });
      }
    } catch (err: any) {
      Alert.alert('Could not update', extractErrorMessage(err, 'Please try again.'));
    } finally {
      setWorking(false);
    }
  };

  const complete = async () => {
    if (code.trim().length < 4) {
      Alert.alert('Code needed', 'Ask the customer for their 4-digit handover code.');
      return;
    }
    setWorking(true);
    try {
      await riderApi.completeJob(jobId, code.trim());
      await refreshJobs();
      Alert.alert(
        job?.job_type === 'PICKUP' ? 'Collected' : 'Delivered',
        job?.job_type === 'PICKUP'
          ? 'Collected. Drop it at the facility to finish this job.'
          : 'Handover confirmed. Nice work.',
        [{ text: 'Done', onPress: () => navigation.goBack() }]
      );
    } catch (err: any) {
      Alert.alert('Handover failed', extractErrorMessage(err, 'That code did not match.'));
    } finally {
      setWorking(false);
    }
  };

  const release = () => {
    Alert.alert('Give this job back?', 'It will be offered to other riders nearby.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Give back',
        style: 'destructive',
        onPress: async () => {
          try {
            await riderApi.releaseJob(jobId, 'Released by rider');
            await refreshJobs();
            navigation.goBack();
          } catch (err: any) {
            Alert.alert('Could not release', extractErrorMessage(err, 'Please try again.'));
          }
        },
      },
    ]);
  };

  /** Starts Google Maps guidance to the stop the rider is heading for. */
  const navigate = async () => {
    if (!job) return;
    const toFacility =
      job.job_type === 'DELIVERY' && job.status === 'ASSIGNED' && Boolean(job.origin_address);
    const opened = await openGoogleMapsRoute(
      toFacility
        ? {
            latitude: job.origin_latitude,
            longitude: job.origin_longitude,
            addressText: job.origin_address,
          }
        : {
            latitude: job.latitude,
            longitude: job.longitude,
            addressText: job.address_text,
          }
    );
    if (!opened) {
      Alert.alert(
        'No route available',
        'This job has no map location or address to route to. Call ahead for directions.'
      );
    }
  };

  const call = () => {
    if (!job?.contact_mobile) return;
    Linking.openURL(`tel:${job.contact_mobile}`);
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]}>
        <ActivityIndicator color={COLORS.Primary} />
      </SafeAreaView>
    );
  }

  if (error || !job) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]}>
        <Ionicons name="alert-circle-outline" size={32} color={COLORS.Error} />
        <Text style={styles.errorText}>{error || 'Job not found.'}</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.goBack()}>
          <Text style={styles.secondaryText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const isPickup = job.job_type === 'PICKUP';

  /*
   * WHICH STOP THE RIDER IS HEADING FOR.
   *
   * A pickup has one stop. A DELIVERY has two: collect the finished laundry
   * from the facility, then take it to the customer. Which one is "next"
   * depends only on whether the rider has set off yet, so the screen shows
   * that stop and Navigate routes to it — rather than showing a customer
   * address to someone whose actual next turning is the facility.
   */
  const headingToFacility = !isPickup && job.status === 'ASSIGNED' && Boolean(job.origin_address);

  const currentStop = headingToFacility
    ? {
        label: 'COLLECT FROM',
        address: job.origin_address,
        latitude: job.origin_latitude,
        longitude: job.origin_longitude,
        contact: null as string | null,
      }
    : {
        label: isPickup ? 'COLLECT FROM' : 'DELIVER TO',
        address: job.address_text,
        latitude: job.latitude,
        longitude: job.longitude,
        contact: job.contact_name,
      };

  const routeAvailable = canRouteTo({
    latitude: currentStop.latitude,
    longitude: currentStop.longitude,
    addressText: currentStop.address,
  });

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.Background} />

      {/* ---------- HEADER ---------- */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          {/* "Dispatch" in the UI; the stored job_type stays 'DELIVERY'. */}
          <Text style={styles.headerTitle}>{isPickup ? 'Pickup' : 'Dispatch'}</Text>
          <Text style={styles.headerSub}>{job.order_number}</Text>
        </View>
        <StatusPill status={job.status} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* ---------- WHERE ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{currentStop.label}</Text>
          <Text style={styles.address}>{currentStop.address || 'No address recorded'}</Text>
          {currentStop.contact ? (
            <Text style={styles.contactName}>{currentStop.contact}</Text>
          ) : null}

          {/* On a delivery, say where the second stop is while the rider is
              still heading for the first. */}
          {headingToFacility ? (
            <Text style={styles.nextStopNote}>
              Then deliver to {job.address_text || 'the customer'}
            </Text>
          ) : null}

          <View style={styles.cardActions}>
            {/* Filled rather than outlined: on a job screen the one thing a
                rider needs most is the way there. */}
            <TouchableOpacity
              style={[styles.navChip, !routeAvailable && styles.navChipDisabled]}
              onPress={navigate}
              disabled={!routeAvailable}
              activeOpacity={0.85}
            >
              <Ionicons name="navigate" size={17} color="#fff" />
              <Text style={styles.navChipText}>Navigate</Text>
            </TouchableOpacity>

            {job.contact_mobile ? (
              <TouchableOpacity style={styles.actionChip} onPress={call}>
                <Ionicons name="call-outline" size={17} color={COLORS.Primary} />
                <Text style={styles.actionChipText}>Call</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {!routeAvailable ? (
            <Text style={styles.noRouteNote}>
              No map location on this job — call ahead for directions.
            </Text>
          ) : null}
        </View>

        {/* ---------- WHAT ----------
            Pieces only. A rider is never shown what an order is worth. */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>
            {job.total_quantity} PIECE{job.total_quantity === 1 ? '' : 'S'} · {job.item_count} LINE
            {job.item_count === 1 ? '' : 'S'}
          </Text>
          {job.items.map((item, index) => (
            <View key={`${item.item_name}-${index}`} style={styles.itemRow}>
              <Text style={styles.itemName} numberOfLines={1}>
                {item.item_name}
              </Text>
              <Text style={styles.itemQty}>×{item.quantity}</Text>
            </View>
          ))}
        </View>

        {/*
          WHAT WAS AGREED AT THE DOOR, once it has been.
          Kept on screen rather than disappearing: it is the record the rider
          can point at if the count is questioned later.
        */}
        {!job.acceptance_required && job.door_acceptance_mode ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>ACCEPTED</Text>
            <Text style={styles.acceptedSummary}>
              {job.door_acceptance_mode === 'WITH_COUNT'
                ? `With counting — ${job.accepted_piece_count} piece${
                    job.accepted_piece_count === 1 ? '' : 's'
                  }`
                : 'Without counting'}
            </Text>
          </View>
        ) : null}

        {/* ---------- THE ONE NEXT ACTION ---------- */}
        {job.status === 'ASSIGNED' ? (
          <PrimaryButton
            label={headingToFacility ? "Loaded — I'm on my way" : "Start — I'm on my way"}
            icon="bicycle-outline"
            busy={working}
            onPress={() => advance('EN_ROUTE')}
          />
        ) : null}

        {job.status === 'EN_ROUTE' ? (
          <PrimaryButton
            label="I've arrived"
            icon="location-outline"
            busy={working}
            onPress={() => advance('ARRIVED')}
          />
        ) : null}

        {/*
          ---------- AT THE DOOR ----------

          COUNTING FIRST, THEN THE CODE. The rider is standing with the other
          party: they count the load, say how they took it, and only then read
          out the code that closes the handover. Asking earlier — on the way
          there — asked about a load they had not yet seen.

          The code card is withheld until the acceptance is recorded, and
          `completeJob` refuses the handover without it, so the order of these
          two is the same whether the rider is looking at the screen or not.
        */}
        {job.status === 'ARRIVED' && job.acceptance_required ? (
          <AcceptOrderSection
            jobType={job.job_type}
            contactName={job.contact_name}
            busy={accepting}
            pieceCount={pieceCount}
            onChangePieceCount={setPieceCount}
            mode={chosenMode}
            onChooseMode={setChosenMode}
            onConfirm={confirmAcceptance}
          />
        ) : null}

        {job.status === 'ARRIVED' && !job.acceptance_required ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>HANDOVER CODE</Text>
            <Text style={styles.codeHelp}>
              Ask {job.contact_name || 'the customer'} to read out their 4-digit code.
            </Text>
            <TextInput
              style={styles.codeInput}
              value={code}
              onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
              keyboardType="number-pad"
              placeholder="0000"
              placeholderTextColor={COLORS.TextSecondary}
              maxLength={6}
              textAlign="center"
            />
            <PrimaryButton
              label={isPickup ? 'Confirm collection' : 'Confirm delivery'}
              icon="checkmark-circle-outline"
              busy={working}
              onPress={complete}
            />
          </View>
        ) : null}

        {/* A COLLECTED pickup is on the bike, not finished. The job ends at
            the facility, which is a single action on the dashboard so a rider
            can empty the whole bike in one go rather than job by job. */}
        {job.status === 'COLLECTED' ? (
          <View style={styles.carryingBanner}>
            <Ionicons name="bicycle" size={20} color={COLORS.PrimaryDark} />
            <Text style={styles.carryingText}>
              Collected and with you now. Finish this by dropping it at the facility — use
              "Drop off at facility" on your home screen.
            </Text>
          </View>
        ) : null}

        {job.status === 'COMPLETED' ? (
          <View style={styles.doneBanner}>
            <Ionicons name="checkmark-circle" size={20} color={COLORS.Success} />
            <Text style={styles.doneText}>
              {isPickup ? 'Delivered to the facility' : 'Delivered'} — nothing left to do here.
            </Text>
          </View>
        ) : null}

        {/* Giving a job back is deliberately quiet: available, not inviting. */}
        {/* Not offered once COLLECTED: the bags are already on the bike, and
            handing the job back would leave them there with no owner. */}
        {/* Offered even while acceptance is outstanding: a rider who cannot do
            the job must not be trapped by a step they do not want to take. */}
        {['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(job.status) ? (
          <TouchableOpacity style={styles.releaseButton} onPress={release}>
            <Text style={styles.releaseText}>Can't do this job</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * ACCEPT ORDER — the compulsory step, inside the order.
 *
 * IT IS THE ONLY THING ON SCREEN THAT CAN BE ACTED ON while it is showing:
 * the caller suppresses every onward action behind it, so this cannot be
 * scrolled past or tapped around. That is the whole point — the previous
 * version sat beside a plain Accept button on the dashboard and was
 * therefore optional.
 *
 * NO DEFAULT MODE. Confirm stays disabled until the rider chooses, because a
 * pre-selected answer is one a tired rider confirms without reading, and
 * "counted" is a claim made to a hotel on their behalf.
 */
function AcceptOrderSection({
  jobType,
  contactName,
  busy,
  mode,
  onChooseMode,
  pieceCount,
  onChangePieceCount,
  onConfirm,
}: {
  jobType: string;
  contactName: string | null;
  busy: boolean;
  mode: DoorAcceptanceMode | null;
  onChooseMode: (m: DoorAcceptanceMode) => void;
  pieceCount: string;
  onChangePieceCount: (v: string) => void;
  onConfirm: () => void;
}) {
  const pieces = Number(pieceCount);
  const countReady = Number.isInteger(pieces) && pieces > 0;
  // WITH_COUNT needs a real number before it means anything; WITHOUT_COUNT is
  // complete as soon as it is chosen.
  const canConfirm = mode === 'WITHOUT_COUNT' || (mode === 'WITH_COUNT' && countReady);

  const Option = ({ value, title, detail }: { value: DoorAcceptanceMode; title: string; detail: string }) => {
    const selected = mode === value;
    return (
      <TouchableOpacity
        style={[styles.acceptOption, selected && styles.acceptOptionSelected]}
        onPress={() => onChooseMode(value)}
        activeOpacity={0.85}
        disabled={busy}
      >
        <Ionicons
          name={selected ? 'radio-button-on' : 'radio-button-off'}
          size={20}
          color={selected ? COLORS.Primary : COLORS.TextSecondary}
        />
        <View style={styles.acceptOptionBody}>
          <Text style={[styles.acceptOptionTitle, selected && styles.acceptOptionTitleSelected]}>
            {title}
          </Text>
          <Text style={styles.acceptOptionDetail}>{detail}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.card, styles.acceptCard]}>
      <Text style={styles.cardLabel}>
        {jobType === 'PICKUP' ? 'CONFIRM PICKUP' : 'CONFIRM COLLECTION'}
      </Text>
      <Text style={styles.codeHelp}>
        {jobType === 'PICKUP'
          ? `Before the code — how did you take this load from ${
              contactName || 'the establishment'
            }?`
          : 'Before the code — how did you take this load from the facility?'}
      </Text>

      <Option
        value="WITH_COUNT"
        title="With Counting & Checked"
        detail="You counted the pieces with their staff."
      />

      {mode === 'WITH_COUNT' ? (
        <View style={styles.countBlock}>
          <Text style={styles.countLabel}>TOTAL PIECES COUNTED</Text>
          <TextInput
            style={styles.codeInput}
            value={pieceCount}
            onChangeText={(t) => onChangePieceCount(t.replace(/[^0-9]/g, '').slice(0, 5))}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor={COLORS.TextSecondary}
            textAlign="center"
            editable={!busy}
          />
        </View>
      ) : null}

      <Option
        value="WITHOUT_COUNT"
        title="Without Counting"
        detail="Not counted. The establishment is asked to agree before you continue."
      />

      <PrimaryButton
        label="Confirm acceptance"
        icon="checkmark-circle-outline"
        busy={busy}
        onPress={canConfirm ? onConfirm : () => {}}
        disabled={!canConfirm}
      />

      {mode === 'WITH_COUNT' && !countReady ? (
        <Text style={styles.acceptHint}>Enter the number of pieces you counted.</Text>
      ) : null}
      {!mode ? <Text style={styles.acceptHint}>Choose one to continue.</Text> : null}
    </View>
  );
}

function PrimaryButton({
  label,
  icon,
  busy,
  onPress,
  // Optional so every existing call site is unchanged. Used by the acceptance
  // section, where Confirm stays inert until a mode has been chosen.
  disabled = false,
}: {
  label: string;
  icon: any;
  busy: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const inert = busy || disabled;
  return (
    <TouchableOpacity
      style={[styles.primaryButton, inert && styles.buttonDisabled]}
      onPress={onPress}
      disabled={inert}
      activeOpacity={0.85}
    >
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <>
          <Ionicons name={icon} size={20} color="#fff" />
          <Text style={styles.primaryText}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const STATUS_LABEL: Record<string, string> = {
  ASSIGNED: 'Accepted',
  EN_ROUTE: 'On the way',
  ARRIVED: 'At the door',
  COLLECTED: 'On your bike',
  HELD: 'On hold',
  COMPLETED: 'Done',
};

function StatusPill({ status }: { status: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{STATUS_LABEL[status] || status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { alignItems: 'center', justifyContent: 'center', gap: SPACING.md, padding: SPACING.lg },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
  },
  backButton: { padding: SPACING.xs },
  headerTitle: {
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.TextPrimary,
  },
  headerSub: { fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary },

  pill: {
    backgroundColor: '#E8F5E9',
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
  },
  pillText: { fontSize: 11, fontWeight: '700', color: COLORS.PrimaryDark },

  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Border,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    color: COLORS.TextSecondary,
    marginBottom: SPACING.sm,
  },
  address: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: TYPOGRAPHY.weights.semibold,
    color: COLORS.TextPrimary,
    lineHeight: 22,
  },
  contactName: { fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary, marginTop: 4 },
  nextStopNote: {
    marginTop: SPACING.sm,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    fontStyle: 'italic',
  },

  cardActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: COLORS.Accent,
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  actionChipText: { color: COLORS.Primary, fontWeight: '600', fontSize: TYPOGRAPHY.sizes.sm },
  navChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.Primary,
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  navChipDisabled: { backgroundColor: COLORS.Border },
  navChipText: { color: '#fff', fontWeight: '700', fontSize: TYPOGRAPHY.sizes.sm },
  noRouteNote: {
    marginTop: SPACING.sm,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },

  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
    gap: SPACING.sm,
  },
  itemName: { flex: 1, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextPrimary },
  itemQty: { fontSize: TYPOGRAPHY.sizes.sm, fontWeight: '700', color: COLORS.TextPrimary },

  primaryButton: {
    height: 54,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  primaryText: { color: '#fff', fontSize: TYPOGRAPHY.sizes.lg, fontWeight: '700' },
  buttonDisabled: { opacity: 0.6 },

  codeHelp: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginBottom: SPACING.md,
    lineHeight: 19,
  },
  codeInput: {
    height: 60,
    borderWidth: 2,
    borderColor: COLORS.Accent,
    borderRadius: BORDER_RADIUS.md,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 8,
    color: COLORS.TextPrimary,
    marginBottom: SPACING.md,
  },

  /* ---------- ACCEPT ORDER ---------- */
  /* Bordered in the accent colour so the step reads as the thing to deal
     with, not as one more card among the order's details. */
  acceptCard: {
    borderWidth: 2,
    borderColor: COLORS.Accent,
  },
  acceptOption: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.Border ?? '#E3E8E4',
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  acceptOptionSelected: {
    borderColor: COLORS.Primary,
    backgroundColor: '#F3FAF5',
  },
  acceptOptionBody: { flex: 1 },
  acceptOptionTitle: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  acceptOptionTitleSelected: { color: COLORS.PrimaryDark },
  acceptOptionDetail: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
    lineHeight: 18,
  },
  countBlock: { marginBottom: SPACING.sm },
  countLabel: {
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: COLORS.TextSecondary,
    marginBottom: SPACING.xs,
  },
  acceptHint: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  acceptedSummary: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },

  carryingBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    backgroundColor: '#E8F5E9',
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Accent,
    padding: SPACING.md,
  },
  carryingText: {
    flex: 1,
    color: COLORS.PrimaryDark,
    fontWeight: '600',
    lineHeight: 19,
    fontSize: TYPOGRAPHY.sizes.sm,
  },

  doneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: '#E9F7EF',
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Success,
    padding: SPACING.md,
  },
  doneText: { flex: 1, color: COLORS.PrimaryDark, fontWeight: '600' },

  releaseButton: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.sm },
  releaseText: { color: COLORS.TextSecondary, fontSize: TYPOGRAPHY.sizes.sm },

  errorText: { color: COLORS.Error, textAlign: 'center', fontSize: TYPOGRAPHY.sizes.base },
  secondaryButton: {
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  secondaryText: { color: COLORS.TextPrimary, fontWeight: '600' },
});
