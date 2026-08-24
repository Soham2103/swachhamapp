import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  StatusBar,
  Switch,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';

import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import useRiderStore from '../../store/riderStore';
import { useAuthStore } from '../../store/authStore';
import { HeldJob, JobOffer, RiderJob } from '../../services/riderApi';
import { canRouteTo, openGoogleMapsRoute } from '../../utils/navigation';

/**
 * The rider's home.
 *
 * Three things, in the order a rider needs them:
 *
 *   1. The duty switch. Everything else depends on it, so it is first and
 *      it is large. Off duty, no offers arrive and no position is sent.
 *   2. Offers waiting for an answer, each with a live countdown. These are
 *      the only time-critical thing on the screen.
 *   3. Jobs already accepted, to get back to.
 *
 * The day's counts sit under those rather than above: they are satisfying
 * to look at and never urgent.
 */
export default function RiderDashboardScreen() {
  const navigation = useNavigation<any>();

  const profile = useRiderStore((s) => s.profile);
  const summary = useRiderStore((s) => s.summary);
  const offers = useRiderStore((s) => s.offers);
  const activeJobs = useRiderStore((s) => s.activeJobs);
  const heldJobs = useRiderStore((s) => s.heldJobs);
  const isLoading = useRiderStore((s) => s.isLoading);
  const isTogglingDuty = useRiderStore((s) => s.isTogglingDuty);
  const error = useRiderStore((s) => s.error);

  const loadDashboard = useRiderStore((s) => s.loadDashboard);
  const goOnline = useRiderStore((s) => s.goOnline);
  const goOffline = useRiderStore((s) => s.goOffline);
  const acceptOffer = useRiderStore((s) => s.acceptOffer);
  const holdOffer = useRiderStore((s) => s.holdOffer);
  const declineOffer = useRiderStore((s) => s.declineOffer);
  const startHeldJob = useRiderStore((s) => s.startHeldJob);
  const dropAtFacility = useRiderStore((s) => s.dropAtFacility);
  const stopWatch = useRiderStore((s) => s.stopWatch);

  const logout = useAuthStore((s: any) => s.logout);

  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadDashboard();
    }, [loadDashboard])
  );

  // Timers must not outlive the screen that started them.
  useEffect(() => () => stopWatch(), [stopWatch]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadDashboard();
    setRefreshing(false);
  };

  const handleDutyToggle = async (next: boolean) => {
    if (next) {
      const result = await goOnline();
      if (!result.ok && result.message) {
        Alert.alert('Cannot go online', result.message);
      }
    } else {
      await goOffline();
    }
  };

  const handleAccept = async (offer: JobOffer) => {
    const result = await acceptOffer(offer.job_id);
    if (result.ok) {
      navigation.navigate('RiderJobDetails', { jobId: offer.job_id });
    } else {
      Alert.alert('Job unavailable', result.message);
    }
  };

  const handleHold = async (offer: JobOffer) => {
    const result = await holdOffer(offer.job_id);
    if (!result.ok) Alert.alert('Job unavailable', result.message);
  };

  const handleStartHeld = async (job: HeldJob) => {
    const result = await startHeldJob(job.job_id);
    if (result.ok) {
      navigation.navigate('RiderJobDetails', { jobId: job.job_id });
    } else {
      Alert.alert('Could not start', result.message);
    }
  };

  const handleDropOff = () => {
    Alert.alert(
      'Drop off at facility?',
      'This confirms your collected pickups have reached the facility.',
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Confirm drop-off',
          onPress: async () => {
            const result = await dropAtFacility();
            Alert.alert(result.ok ? 'Dropped off' : 'Could not drop off', result.message);
          },
        },
      ]
    );
  };

  const isOnline = Boolean(profile?.is_online);
  const carryingJobs = summary?.carrying_jobs ?? 0;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.Background} />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* ---------- HEADER ---------- */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>
              {profile?.name ? `Hi, ${profile.name}` : 'Rider'}
            </Text>
            <Text style={styles.subGreeting}>
              {profile?.vehicle_number || 'No vehicle on file'}
            </Text>
          </View>

          <TouchableOpacity
            onPress={() =>
              Alert.alert('Sign out', 'Sign out of Swachham?', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Sign out',
                  style: 'destructive',
                  onPress: async () => {
                    stopWatch();
                    await logout?.();
                  },
                },
              ])
            }
            style={styles.iconButton}
            accessibilityLabel="Sign out"
          >
            <Ionicons name="log-out-outline" size={22} color={COLORS.TextSecondary} />
          </TouchableOpacity>
        </View>

        {/* ---------- DUTY SWITCH ---------- */}
        <View style={[styles.dutyCard, isOnline ? styles.dutyCardOn : styles.dutyCardOff]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.dutyTitle, isOnline && styles.dutyTitleOn]}>
              {isOnline ? 'You are online' : 'You are offline'}
            </Text>
            <Text style={[styles.dutyBody, isOnline && styles.dutyBodyOn]}>
              {isOnline
                ? 'Pickups near you will be offered here.'
                : 'Go online to start receiving pickups near you.'}
            </Text>
          </View>

          {isTogglingDuty ? (
            <ActivityIndicator color={isOnline ? '#fff' : COLORS.Primary} />
          ) : (
            <Switch
              value={isOnline}
              onValueChange={handleDutyToggle}
              trackColor={{ false: COLORS.Border, true: COLORS.Accent }}
              thumbColor={isOnline ? '#fff' : '#f4f3f4'}
            />
          )}
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={18} color={COLORS.Error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* ---------- COLLECTED, NOT YET AT THE FACILITY ----------
            Shown only while the rider is actually carrying something. There
            is no capacity meter: how much a rider can take is their call,
            not a number the server keeps. */}
        {carryingJobs > 0 ? (
          <View style={styles.loadCard}>
            <View style={styles.loadTop}>
              <Text style={styles.loadTitle}>With you now</Text>
              <Text style={styles.loadFigure}>{carryingJobs}</Text>
            </View>

            <Text style={styles.loadHint}>
              {carryingJobs} pickup{carryingJobs === 1 ? '' : 's'} collected, not yet at the facility
            </Text>

            <TouchableOpacity style={styles.dropButton} onPress={handleDropOff} activeOpacity={0.85}>
              <Ionicons name="business-outline" size={18} color="#fff" />
              <Text style={styles.dropText}>Drop off at facility</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ---------- ON HOLD ----------
            Jobs the rider claimed but deferred because the bike was full. */}
        {heldJobs.length > 0 ? (
          <>
            <SectionHeading
              title="On hold"
              count={heldJobs.length}
              hint="Yours until the timer runs out"
            />
            {heldJobs.map((job) => (
              <HeldCard key={job.job_id} job={job} onStart={() => handleStartHeld(job)} />
            ))}
          </>
        ) : null}

        {/* ---------- OFFERS ---------- */}
        <SectionHeading
          title="Offers"
          hint={isOnline ? 'First to accept takes the job' : undefined}
          count={offers.length}
        />

        {offers.length === 0 ? (
          <EmptyState
            icon={isOnline ? 'time-outline' : 'moon-outline'}
            text={
              isOnline
                ? 'No offers right now. You will be alerted when an order is confirmed nearby.'
                : 'Go online to receive offers.'
            }
          />
        ) : (
          offers.map((offer) => (
            <OfferCard
              key={offer.offer_id}
              offer={offer}
              onAccept={() => handleAccept(offer)}
              onHold={() => handleHold(offer)}
              onDecline={() => declineOffer(offer.job_id)}
            />
          ))
        )}

        {/* ---------- ACTIVE JOBS ---------- */}
        <SectionHeading title="Your jobs" count={activeJobs.length} />

        {activeJobs.length === 0 ? (
          <EmptyState icon="cube-outline" text="Nothing on your plate right now." />
        ) : (
          activeJobs.map((job) => (
            <JobCard
              key={job.job_id}
              job={job}
              onPress={() => navigation.navigate('RiderJobDetails', { jobId: job.job_id })}
            />
          ))
        )}

        {/* ---------- TODAY ---------- */}
        <SectionHeading title="Today" />

        <View style={styles.statRow}>
          <StatTile label="Pickups" value={summary?.today.pickups ?? 0} />
          <StatTile label="Deliveries" value={summary?.today.deliveries ?? 0} />
          <StatTile label="All time" value={summary?.lifetime.completed ?? 0} />
        </View>

        {isLoading && !refreshing ? (
          <ActivityIndicator style={{ marginTop: SPACING.lg }} color={COLORS.Primary} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/* =====================================================
 * OFFER CARD
 * ===================================================== */

/**
 * One offer, with the seconds it has left.
 *
 * The countdown is computed from `expires_at` rather than counted down from a
 * fixed number, so a card that was on screen while the phone slept shows the
 * truth when it wakes rather than a number that kept ticking in a dream.
 */
function OfferCard({
  offer,
  onAccept,
  onHold,
  onDecline,
}: {
  offer: JobOffer;
  onAccept: () => void;
  onHold: () => void;
  onDecline: () => void;
}) {
  /*
   * Counts down from the SERVER's number of seconds, not from a timestamp.
   *
   * The server sends how long is left; the card ticks that down locally and
   * each poll re-seeds it with the server's fresh figure. Nothing here depends
   * on the phone's clock agreeing with the server's, which is what an
   * `expires_at` comparison would have required.
   */
  const [secondsLeft, setSecondsLeft] = useState(offer.expires_in_seconds);

  useEffect(() => {
    setSecondsLeft(offer.expires_in_seconds);
    const timer = setInterval(() => setSecondsLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [offer.expires_in_seconds, offer.offer_id]);

  const expired = secondsLeft <= 0;

  return (
    <View style={[styles.offerCard, expired && styles.offerCardExpired]}>
      <View style={styles.offerTop}>
        <View style={styles.offerBadge}>
          <Ionicons
            name={offer.job_type === 'PICKUP' ? 'arrow-up-circle' : 'arrow-down-circle'}
            size={16}
            color={COLORS.Primary}
          />
          <Text style={styles.offerBadgeText}>
            {offer.job_type === 'PICKUP' ? 'PICKUP' : 'DELIVERY'}
          </Text>
        </View>

        <View style={[styles.countdown, expired && styles.countdownExpired]}>
          <Text style={[styles.countdownText, expired && styles.countdownTextExpired]}>
            {expired ? 'Expired' : `${secondsLeft}s`}
          </Text>
        </View>
      </View>

      <View style={styles.offerHeadline}>
        <Text style={styles.offerDistance}>{offer.distance_label}</Text>
        {offer.weight_kg > 0 ? (
          <Text style={styles.offerWeight}>{offer.weight_kg} kg</Text>
        ) : null}
      </View>
      <Text style={styles.offerAddress} numberOfLines={2}>
        {offer.address_text || 'Address will be shown once accepted'}
      </Text>

      <Text style={styles.offerMeta}>
        {offer.order_number} · {offer.item_count} item{offer.item_count === 1 ? '' : 's'}
      </Text>


      {/*
        THREE ANSWERS, not two.

        Pass gives the job away. Hold keeps it reserved for this rider until
        they are ready for it. Accept takes it now.

        The app does not steer between them. Whether a second pickup is
        possible depends on what is already on the vehicle and how far the
        rider is from finishing it -- things only the rider can see -- so all
        three are presented plainly and the judgement stays with them.
      */}
      <View style={styles.offerActions}>
        <TouchableOpacity style={styles.declineButton} onPress={onDecline} activeOpacity={0.85}>
          <Text style={styles.declineText}>Pass</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.holdButton, expired && styles.buttonDisabled]}
          onPress={onHold}
          disabled={expired}
          activeOpacity={0.85}
        >
          <Ionicons name="pause-circle-outline" size={17} color={COLORS.Primary} />
          <Text style={styles.holdText}>Hold</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.acceptButton, expired && styles.buttonDisabled]}
          onPress={onAccept}
          disabled={expired}
          activeOpacity={0.85}
        >
          <Ionicons name="checkmark" size={18} color="#fff" />
          <Text style={styles.acceptText}>Accept</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* =====================================================
 * HELD CARD
 * ===================================================== */

/**
 * A job the rider parked because the bike was full.
 *
 * The reclaim countdown is shown rather than hidden: a hold is not forever,
 * and a rider should learn that from the card, not from it disappearing.
 */
function HeldCard({ job, onStart }: { job: HeldJob; onStart: () => void }) {
  return (
    <View style={styles.heldCard}>
      <View style={styles.offerTop}>
        <View style={styles.offerBadge}>
          <Ionicons name="pause-circle" size={16} color={COLORS.Warning} />
          <Text style={styles.heldBadgeText}>ON HOLD</Text>
        </View>
        <Text style={styles.heldTimer}>
          {job.reclaim_in_minutes > 0
            ? `${job.reclaim_in_minutes} min left`
            : 'Being reassigned'}
        </Text>
      </View>

      <Text style={styles.jobTitle} numberOfLines={2}>
        {job.address_text || job.order_number}
      </Text>
      <Text style={styles.jobMeta}>{job.order_number}</Text>

      <TouchableOpacity style={styles.startHeldButton} onPress={onStart} activeOpacity={0.85}>
        <Ionicons name="play" size={16} color="#fff" />
        <Text style={styles.startHeldText}>Start this now</Text>
      </TouchableOpacity>
    </View>
  );
}

/* =====================================================
 * JOB CARD
 * ===================================================== */

const JOB_STATUS_LABEL: Record<string, string> = {
  ASSIGNED: 'Accepted',
  EN_ROUTE: 'On the way',
  ARRIVED: 'At the door',
  COLLECTED: 'On your bike',
  HELD: 'On hold',
};

function JobCard({ job, onPress }: { job: RiderJob; onPress: () => void }) {
  const target = {
    latitude: job.latitude,
    longitude: job.longitude,
    addressText: job.address_text,
  };

  return (
    <TouchableOpacity style={styles.jobCard} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.jobIcon}>
        <Ionicons
          name={job.job_type === 'PICKUP' ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'}
          size={22}
          color={COLORS.Primary}
        />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={styles.jobTitle} numberOfLines={1}>
          {job.address_text || job.order_number}
        </Text>
        <Text style={styles.jobMeta}>
          {job.order_number} · {JOB_STATUS_LABEL[job.status] || job.status}
        </Text>
      </View>

      {/*
        Routing without opening the job first.
        A rider glancing at the list on a handlebar mount should be able to
        set off in one tap. `stopPropagation` keeps the tap off the card,
        which would otherwise navigate into the detail screen underneath.
      */}
      {canRouteTo(target) ? (
        <TouchableOpacity
          style={styles.jobNavButton}
          onPress={(event) => {
            event.stopPropagation();
            void openGoogleMapsRoute(target);
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={`Navigate to ${job.address_text || job.order_number}`}
        >
          <Ionicons name="navigate" size={18} color="#fff" />
        </TouchableOpacity>
      ) : null}

      <Ionicons name="chevron-forward" size={20} color={COLORS.TextSecondary} />
    </TouchableOpacity>
  );
}

/* =====================================================
 * SMALL PIECES
 * ===================================================== */

function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count?: number;
  hint?: string;
}) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>
        {title}
        {typeof count === 'number' && count > 0 ? ` (${count})` : ''}
      </Text>
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
    </View>
  );
}

function EmptyState({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={26} color={COLORS.TextSecondary} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/* =====================================================
 * STYLES
 * ===================================================== */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  greeting: {
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.TextPrimary,
  },
  subGreeting: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  iconButton: { padding: SPACING.sm },

  dutyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  dutyCardOn: { backgroundColor: COLORS.Primary },
  dutyCardOff: { backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Border },
  dutyTitle: {
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.TextPrimary,
  },
  dutyTitleOn: { color: '#fff' },
  dutyBody: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 3,
  },
  dutyBodyOn: { color: 'rgba(255,255,255,0.85)' },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: '#FDECEC',
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    marginBottom: SPACING.md,
  },
  errorText: { flex: 1, color: COLORS.Error, fontSize: TYPOGRAPHY.sizes.sm },

  sectionHeading: {
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  sectionTitle: {
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: TYPOGRAPHY.weights.semibold,
    color: COLORS.TextPrimary,
  },
  sectionHint: {
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },

  // ---- load / capacity ----
  loadCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Border,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  loadTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  loadTitle: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: TYPOGRAPHY.weights.semibold,
    color: COLORS.TextPrimary,
  },
  loadFigure: {
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.Primary,
    fontVariant: ['tabular-nums'],
  },
  loadHint: {
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: SPACING.sm,
  },
  dropButton: {
    marginTop: SPACING.md,
    height: 46,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.PrimaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  dropText: { color: '#fff', fontWeight: '700', fontSize: TYPOGRAPHY.sizes.base },

  // ---- held ----
  heldCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Warning,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  heldBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.Warning,
    letterSpacing: 0.5,
  },
  heldTimer: { fontSize: 12, fontWeight: '600', color: COLORS.TextSecondary },
  startHeldButton: {
    marginTop: SPACING.md,
    height: 44,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  startHeldText: { color: '#fff', fontWeight: '700' },

  // ---- offer weight / overload ----
  offerHeadline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  offerWeight: {
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.TextSecondary,
    fontVariant: ['tabular-nums'],
  },

  // ---- hold / accept variants ----
  holdButton: {
    flex: 1.4,
    height: 46,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  holdText: { color: COLORS.Primary, fontWeight: '700', fontSize: TYPOGRAPHY.sizes.sm },
  offerCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Accent,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    ...SHADOWS.light,
  },
  offerCardExpired: { opacity: 0.55, borderColor: COLORS.Border },
  offerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  offerBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  offerBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.Primary,
    letterSpacing: 0.5,
  },
  countdown: {
    backgroundColor: '#E8F5E9',
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
  },
  countdownExpired: { backgroundColor: '#F3F4F6' },
  countdownText: { fontSize: 12, fontWeight: '700', color: COLORS.PrimaryDark },
  countdownTextExpired: { color: COLORS.TextSecondary },

  offerDistance: {
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.TextPrimary,
  },
  offerAddress: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
    lineHeight: 19,
  },
  offerMeta: {
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: SPACING.xs,
  },
  offerActions: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  declineButton: {
    flex: 1,
    height: 46,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineText: { color: COLORS.TextSecondary, fontWeight: '600' },
  acceptButton: {
    flex: 1.4,
    height: 46,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  acceptText: { color: '#fff', fontWeight: '700', fontSize: TYPOGRAPHY.sizes.base },
  buttonDisabled: { opacity: 0.5 },

  jobCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  jobIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  jobTitle: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: TYPOGRAPHY.weights.semibold,
    color: COLORS.TextPrimary,
  },
  jobMeta: { fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary, marginTop: 2 },
  jobNavButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.Primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.xs,
  },

  empty: {
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderStyle: 'dashed',
    padding: SPACING.lg,
  },
  emptyText: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    lineHeight: 19,
  },

  statRow: { flexDirection: 'row', gap: SPACING.sm },
  statTile: {
    flex: 1,
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    padding: SPACING.md,
    alignItems: 'center',
  },
  statValue: {
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: TYPOGRAPHY.weights.bold,
    color: COLORS.Primary,
  },
  statLabel: { fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary, marginTop: 2 },
});
