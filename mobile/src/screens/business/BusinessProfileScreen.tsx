import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigationState } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import businessOrderApi, { BusinessProfile } from '../../services/businessOrderApi';
import { extractErrorMessage } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { DEMO_MODE } from '../../demo/demoMode';
import { resetDemoData } from '../../demo/demoBusinessOrderApi';
import DemoBadge from '../../components/demo/DemoBadge';

type Row = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  danger?: boolean;
  onPress?: (nav: any) => void;
};

// Mirrors the profile layout. "Addresses" is intentionally not listed.
const ROWS: Row[] = [
  {
    key: 'details',
    icon: 'person-outline',
    title: 'User Profile',
    subtitle: 'Manage your details',
    onPress: (nav) => nav.navigate('BusinessProfileDetailsScreen'),
  },
  {
    key: 'orders',
    icon: 'bag-outline',
    title: 'Your Orders',
    subtitle: 'View your current and past orders',
    onPress: (nav) => nav.navigate('BusinessOrders'),
  },
  {
    key: 'store-locator',
    icon: 'location-outline',
    title: 'Store Locator',
    subtitle: 'Find the nearest Swachham store',
    onPress: (nav) => nav.navigate('StoreLocatorScreen'),
  },
  {
    key: 'privacy',
    icon: 'shield-checkmark-outline',
    title: 'Privacy Policy',
    subtitle: 'How Swachham handles your data',
    onPress: (nav) => nav.navigate('LegalDocument', { document: 'privacy' }),
  },
  {
    key: 'express',
    icon: 'rocket-outline',
    title: 'Know About Express Service',
    subtitle: 'Express Service',
  },
  {
    key: 'terms',
    icon: 'document-text-outline',
    title: 'Terms & Conditions',
    subtitle: 'The terms you agree to when ordering',
    onPress: (nav) => nav.navigate('LegalDocument', { document: 'terms' }),
  },
  /* FAQ was removed from the Business Profile. It had no screen behind it —
     the row rendered without an `onPress` and did nothing when tapped — and
     no FAQ content, component or API existed anywhere else in the app, so
     there is nothing left over to clean up. The customer profile keeps its
     own list; only the Business one changed. */
  {
    key: 'delete',
    icon: 'trash-outline',
    title: 'Delete account',
    subtitle: 'Request permanent removal of your account',
    danger: true,
  },
];

export default function BusinessProfileScreen({ navigation }: any) {
  /**
   * Whether THIS screen's own stack has somewhere to pop to.
   *
   * `navigation.canGoBack()` is not the test: from a tab's first page it can
   * still report true because the tab navigator sits inside a parent stack,
   * which would put a Back button on a root page that then left the Business
   * section entirely.
   */
  const canGoBack = useNavigationState((state) => state.index > 0);

  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  /** Demo builds only; always false in a production build. */
  const [isResettingDemo, setIsResettingDemo] = useState(false);
  const { logout } = useAuthStore();

  const load = useCallback(async () => {
    try {
      setError('');
      setIsLoading(true);
      const response = await businessOrderApi.getProfile();
      setProfile(response.data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load profile'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', load);
    return unsubscribe;
  }, [navigation, load]);

  /**
   * RESET DEMO DATA — demo builds only.
   *
   * Throws away everything the demo has created on THIS PHONE and starts it
   * over: an EMPTY order list, the demo profile, an empty cart, and numbering
   * back at DEMO-1001. There are no sample orders to restore — the demo seeds
   * none, so a reset leaves the Orders list blank until the next order is
   * placed.
   *
   * It cannot reach anything else. The demo build has no connection to any
   * server (the API client refuses every request), so "reset" is a local file
   * being rewritten and nothing more — there is no production data within its
   * reach to affect.
   */
  const handleResetDemo = () => {
    Alert.alert(
      'Reset demo data',
      'Are you sure you want to reset the demo data?\n\nOrders created during this demonstration will be removed and the order list will start empty again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              setIsResettingDemo(true);
              await resetDemoData();
              // The profile is part of what was reset, so it is re-read here;
              // every other screen reloads when it is next focused.
              await load();
              Alert.alert('Demo data reset', 'The order list is empty and demo numbering starts again at DEMO-1001.');
            } catch {
              Alert.alert('Could not reset', 'Please try again.');
            } finally {
              setIsResettingDemo(false);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Business name comes from registration and is shown, never re-entered. */}
        <View style={styles.headerCard}>
          {/* Swachham logo, top-left, matching the shared Business header. */}
          <View style={styles.headerTopRow}>
            {/* NO BACK BUTTON AT THE ROOT. Profile is the first page of its
                tab, so there is nothing to go back TO; it appears only once
                the stack has somewhere to pop to. The row is laid out with
                `gap`, so its absence leaves no hole — the logo simply moves
                to the leading edge. */}
            {canGoBack ? (
              <TouchableOpacity
                style={styles.headerBack}
                onPress={() => navigation.goBack()}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <Ionicons name="arrow-back" size={22} color={COLORS.Surface} />
              </TouchableOpacity>
            ) : null}
            <Image
              source={require('../../../assets/swachham-logo.png')}
              style={styles.headerLogo}
              resizeMode="contain"
              accessibilityLabel="Swachham"
            />
            {/* Renders nothing outside a demo build. */}
            <DemoBadge tone="light" />
          </View>

          {isLoading ? (
            <ActivityIndicator color={COLORS.Surface} style={{ marginTop: SPACING.lg }} />
          ) : (
            <>
              <Text style={styles.businessName} numberOfLines={2}>
                {profile?.business_name || '—'}
              </Text>
              <Text style={styles.headerMeta}>{profile?.mobile_number || 'Mobile not set'}</Text>
              <Text style={styles.headerMeta}>{profile?.email_id || profile?.account_email || ''}</Text>
            </>
          )}
        </View>

        <Text style={styles.sectionTitle}>Your Information</Text>

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={load}>
              <Text style={styles.retryLink}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.listCard}>
          {ROWS.map((row, index) => (
            <TouchableOpacity
              key={row.key}
              style={[styles.row, index < ROWS.length - 1 && styles.rowDivider]}
              activeOpacity={0.7}
              onPress={() => {
                if (row.onPress) row.onPress(navigation);
              }}
            >
              <View style={styles.rowIconCircle}>
                <Ionicons
                  name={row.icon}
                  size={22}
                  color={row.danger ? COLORS.Error : COLORS.TextPrimary}
                />
              </View>
              <View style={styles.rowTextWrap}>
                <Text style={[styles.rowTitle, row.danger && styles.rowTitleDanger]}>{row.title}</Text>
                <Text style={styles.rowSubtitle}>{row.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={COLORS.TextSecondary} />
            </TouchableOpacity>
          ))}
        </View>

        {/* =================================================
            DEMO CONTROLS

            Present ONLY in a demo build. Its own quiet card
            rather than a row inside "Your Information": it
            is about the demonstration, not about the hotel's
            account, and mixing the two would read as an
            internal tool having been left switched on.
        ================================================= */}
        {DEMO_MODE ? (
          <>
            <Text style={styles.sectionTitle}>Demonstration</Text>
            <View style={styles.listCard}>
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={handleResetDemo}
                disabled={isResettingDemo}
                accessibilityRole="button"
                accessibilityLabel="Reset demo data"
              >
                <View style={styles.rowIconCircle}>
                  {isResettingDemo ? (
                    <ActivityIndicator size="small" color={COLORS.TextPrimary} />
                  ) : (
                    <Ionicons name="refresh-outline" size={22} color={COLORS.TextPrimary} />
                  )}
                </View>
                <View style={styles.rowTextWrap}>
                  <Text style={styles.rowTitle}>Reset Demo Data</Text>
                  <Text style={styles.rowSubtitle}>
                    Clear the orders placed in this demo and start again
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={COLORS.TextSecondary} />
              </TouchableOpacity>
            </View>
          </>
        ) : null}

        <TouchableOpacity style={styles.logoutButton} onPress={() => logout()} activeOpacity={0.8}>
          <Ionicons name="log-out-outline" size={20} color={COLORS.Error} />
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  scroll: { paddingBottom: SPACING.xxl },
  headerCard: {
    backgroundColor: COLORS.Primary,
    borderBottomLeftRadius: BORDER_RADIUS.xl,
    borderBottomRightRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xl,
    minHeight: 190,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  headerLogo: {
    width: 40,
    height: 40,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Surface,
    borderWidth: 1,
    borderColor: COLORS.Border,
  },
  headerBack: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  businessName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.Surface,
    marginBottom: SPACING.xs,
  },
  headerMeta: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.Surface,
    opacity: 0.9,
  },
  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    marginTop: SPACING.lg,
    marginBottom: SPACING.md,
    marginHorizontal: SPACING.lg,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginHorizontal: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  errorText: { flex: 1, fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.Error },
  retryLink: { fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '700', color: COLORS.Primary },
  listCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    marginHorizontal: SPACING.md,
    overflow: 'hidden',
    ...SHADOWS.light,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.md, paddingHorizontal: SPACING.md },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: COLORS.Border },
  rowIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.Background,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
  },
  rowTextWrap: { flex: 1 },
  rowTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  rowTitleDanger: { color: COLORS.Error },
  rowSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.lg,
    marginHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Error,
  },
  logoutText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.Error,
  },
});
