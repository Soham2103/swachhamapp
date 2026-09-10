import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Image,
  Keyboard,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, TYPOGRAPHY, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import SwachhamChatLauncher from '../../components/chat/SwachhamChatLauncher';
import DemoBadge from '../../components/demo/DemoBadge';
import SectionHeading from '../../components/SectionHeading';
import { useAuthStore } from '../../store/authStore';
import businessApi from '../../services/businessApi';
import businessOrderApi from '../../services/businessOrderApi';
import serviceApi from '../../services/serviceApi';
import { extractErrorMessage } from '../../services/api';
import { Business, Service } from '../../types';

/*
 * The two Laundry Type cards are the same card in two finishes: the Hotel card
 * is teal with the saffron accent on it, the Guest card is the warm off-white
 * inverse with the teal as its ink. Both keep the saffron border, which is
 * what makes them read as a pair.
 */
/** The Hotel card's surface, and the Guest card's ink. */
const LAUNDRY_TEAL = '#3d6f73';
/** The saffron accent shared by both cards. */
const LAUNDRY_SAFFRON = '#ffbd4a';
/** The Guest card's surface: a warm off-white, not a flat grey. */
const LAUNDRY_OFF_WHITE = '#FDF8F0';

/** The largest the card title is allowed to get, however wide the screen. */
const CARD_TITLE_MAX = 32;
/** The smallest it may shrink to before readability outranks fitting. */
const CARD_TITLE_MIN = 20;
/**
 * How wide "GUEST LAUNDRY" — the longer of the two labels — is in multiples
 * of its own font size, in the heaviest weight the system font offers.
 * Measured from the font's advance widths, with headroom for the fact that
 * iOS and Android do not ship the same face.
 */
const TITLE_WIDTH_IN_EMS = 9.2;

/**
 * The card title's size on THIS screen.
 *
 * SIZED TO HOLD ONE LINE, because the two lines it used to take were what
 * pushed the second card off the bottom of the screen. Dividing the card's
 * inner width by the label's width in ems gives the largest size that still
 * fits across, and the cap keeps a tablet from turning it into a billboard.
 *
 * Deriving it rather than fixing it is also what stops the label spilling on
 * a narrow phone: a single word too wide for its line does not wrap, it
 * overflows.
 */
function cardTitleSize(width: number): number {
  const inner = width - SPACING.lg * 2 - 2.5 * 2 - SPACING.md * 2;
  return Math.max(
    CARD_TITLE_MIN,
    Math.min(CARD_TITLE_MAX, Math.floor(inner / TITLE_WIDTH_IN_EMS))
  );
}

export default function HomeScreen({ navigation }: any) {
  const { user, userType } = useAuthStore();

  /*
   * THIS SCREEN SERVES BOTH APPS. It is registered on the Customer tab
   * navigator AND inside BusinessHomeStack, so anything shown here appears
   * to both unless it is gated.
   *
   * A CUSTOMER MUST NOT SEE THE BUSINESS NAME. They are booking their own
   * laundry; whose establishment record they happen to be attached to is an
   * internal detail. The association itself is untouched — this hides a
   * label, it does not change what the backend stores or sends.
   */
  const isBusinessUser = userType === 'business' || String(user?.role || '').toLowerCase() === 'business';
  const { width } = useWindowDimensions();
  const titleSize = cardTitleSize(width);
  const [profile, setProfile] = useState<any>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loadingBusinesses, setLoadingBusinesses] = useState(true);

  useEffect(() => {
    fetchBusinesses();
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      const res = await businessOrderApi.getProfile();
      if (res?.data) {
        setProfile(res.data);
      }
    } catch {
      // Ignored for non-business or offline
    }
  };

  const fetchBusinesses = async () => {
    try {
      setLoadingBusinesses(true);
      const res = await businessApi.getBusinesses();
      setBusinesses((res.data as any).businesses || []);
    } catch (error) {
      console.error('Error fetching businesses:', error);
    } finally {
      setLoadingBusinesses(false);
    }
  };

  const handleSelectLaundryType = (type: 'hotel' | 'guest', label: string) => {
    navigation.navigate('OrderType', {
      laundryType: type,
      laundryLabel: label,
    });
  };

  const handleSelectService = (item: Service) => {
    // Navigate using existing navigation flow
    if (item.category_id || item.categoryId) {
      navigation.navigate('ServiceCategory', {
        categoryId: item.category_id || item.categoryId,
        name: item.category_name || item.categoryName || item.name,
        serviceId: item.id,
      });
    } else {
      // If no category ID, navigate with service name
      navigation.navigate('ServiceCategory', {
        name: item.name,
        serviceId: item.id,
      });
    }
  };

  const renderBusiness = ({ item }: { item: Business }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('BusinessDetails', { businessId: item.id })}
      activeOpacity={0.7}
    >
      <Text style={styles.businessName}>{(item as any).name || item.businessName}</Text>
      <Text style={styles.businessAddress}>{item.city}, {item.state}</Text>
    </TouchableOpacity>
  );

  const formatPrice = (item: Service) => {
    const priceVal = item.price ?? item.customer_price ?? item.basePrice;
    if (priceVal != null && Number(priceVal) > 0) {
      return `₹${priceVal} / ${item.unit || 'piece'}`;
    }
    return 'Price on request';
  };

  const renderServiceResult = ({ item }: { item: Service }) => (
    <TouchableOpacity
      style={styles.serviceResultCard}
      onPress={() => handleSelectService(item)}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${item.category_name || 'Service'}`}
    >
      <View style={styles.serviceThumb}>
        {item.image_url || item.imageUrl ? (
          <Image
            source={{ uri: item.image_url || item.imageUrl }}
            style={styles.serviceThumbImage}
            resizeMode="contain"
          />
        ) : (
          <Ionicons name="shirt-outline" size={24} color={COLORS.Primary} />
        )}
      </View>

      <View style={styles.serviceContent}>
        <Text style={styles.serviceName} numberOfLines={1}>
          {item.name}
        </Text>
        
        {item.category_name ? (
          <Text style={styles.serviceCategory} numberOfLines={1}>
            {item.category_name}
          </Text>
        ) : null}

        {item.description ? (
          <Text style={styles.serviceDescription} numberOfLines={2}>
            {item.description}
          </Text>
        ) : null}

        <View style={styles.serviceFooterRow}>
          <Text style={styles.servicePrice}>{formatPrice(item)}</Text>
          
          {item.service_types && item.service_types.length > 0 ? (
            <View style={styles.serviceTypesList}>
              {item.service_types.map((st) => (
                <View key={st} style={styles.serviceTypeBadge}>
                  <Text style={styles.serviceTypeBadgeText}>
                    {st.replace(/_/g, ' ')}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={20} color={COLORS.TextSecondary} style={styles.chevron} />
    </TouchableOpacity>
  );

  const establishmentName =
    profile?.business_name ||
    profile?.establishment_name ||
    user?.establishment_name ||
    user?.business_name ||
    user?.establishmentName ||
    user?.businessName ||
    'Swachham';

  const userName = user?.name || profile?.contact_person_name || 'User';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Full-width Top Navigator Logo Banner with highlighted bottom lines */}
      <View style={styles.topLogoBannerWrap}>
        <Image
          source={require('../../../assets/swachham-header-logo.png')}
          style={styles.topLogoBanner}
          resizeMode="contain"
          accessibilityLabel="Swachham"
        />
      </View>

      {/* Line 1 is the establishment, and it is BUSINESS ONLY — see
          `isBusinessUser`. A customer sees their own name and nothing else. */}
      <View style={styles.header}>
        {/* Renders nothing in a production build. This screen draws its own
            banner rather than using BusinessHeader, so the marker is placed
            here too — it is the first screen after signing in. */}
        <DemoBadge style={styles.demoBadge} />
        {isBusinessUser ? (
          <Text style={styles.establishmentName} numberOfLines={1}>
            {establishmentName}
          </Text>
        ) : null}
        <Text style={styles.userName} numberOfLines={1}>
          {userName}
        </Text>
        <View style={styles.userDivider} />
      </View>

      {/* Laundry Type Selection Section.

          A ScrollView, not a plain View: the card titles are now large enough
          that the two cards are taller than a short phone's remaining space,
          and a fixed View would simply cut the second one off. */}
      <ScrollView
        style={styles.defaultContent}
        contentContainerStyle={styles.defaultContentInner}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.laundryTypeSection}>
          <SectionHeading>LAUNDRY TYPE</SectionHeading>

          <View style={styles.laundryCardsContainer}>
            {/* Hotel Laundry Card */}
            <TouchableOpacity
              style={styles.laundryCard}
              onPress={() => handleSelectLaundryType('hotel', 'Hotel Laundry')}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Hotel Laundry"
            >
              {/* Icon left, chevron right. The title no longer shares this
                  row: at its size it needs the card's full width, and boxed
                  in between these two it would have had barely a third. */}
              <View style={styles.cardTopRow}>
                <View style={styles.iconCircle}>
                  <Ionicons name="business" size={26} color={LAUNDRY_SAFFRON} />
                </View>
                <Ionicons name="chevron-forward-circle" size={28} color={LAUNDRY_SAFFRON} />
              </View>

              <Text
                style={[
                  styles.cardTitle,
                  styles.cardTitleHotel,
                  { fontSize: titleSize, lineHeight: titleSize + 2 },
                ]}
              >
                HOTEL LAUNDRY
              </Text>
              {/* A short accent rule under the label, tying it to the icon
                  above and separating it from the small print below. */}
              <View style={styles.cardTitleUnderline} />
              <Text style={styles.cardSubtitle}>Linen & property-owned items</Text>

              <View style={styles.cardDivider} />

              <View style={styles.cardFeatures}>
                <View style={styles.featureItem}>
                  <Ionicons name="checkmark" size={16} color={LAUNDRY_SAFFRON} />
                  <Text style={styles.featureText}>Hotel linen, towels & bedding</Text>
                </View>
                <View style={styles.featureItem}>
                  <Ionicons name="checkmark" size={16} color={LAUNDRY_SAFFRON} />
                  <Text style={styles.featureText}>Property & uniform management</Text>
                </View>
              </View>
            </TouchableOpacity>

            {/* Guest Laundry Card */}
            <TouchableOpacity
              style={[styles.laundryCard, styles.laundryCardGuest]}
              onPress={() => handleSelectLaundryType('guest', 'Guest Laundry')}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Guest Laundry"
            >
              <View style={styles.cardTopRow}>
                <View style={[styles.iconCircle, styles.iconCircleGuest]}>
                  <Ionicons name="person" size={26} color={LAUNDRY_SAFFRON} />
                </View>
                <Ionicons name="chevron-forward-circle" size={28} color={LAUNDRY_TEAL} />
              </View>

              <Text
                style={[
                  styles.cardTitle,
                  styles.cardTitleGuest,
                  { fontSize: titleSize, lineHeight: titleSize + 2 },
                ]}
              >
                GUEST LAUNDRY
              </Text>
              <View style={[styles.cardTitleUnderline, styles.cardTitleUnderlineGuest]} />
              <Text style={[styles.cardSubtitle, styles.cardSubtitleGuest]}>
                Items belonging to your guests
              </Text>

              <View style={[styles.cardDivider, styles.cardDividerGuest]} />

              <View style={styles.cardFeatures}>
                <View style={styles.featureItem}>
                  <Ionicons name="checkmark" size={16} color={LAUNDRY_TEAL} />
                  <Text style={[styles.featureText, styles.featureTextGuest]}>
                    Personal guest garment care
                  </Text>
                </View>
                <View style={styles.featureItem}>
                  <Ionicons name="checkmark" size={16} color={LAUNDRY_TEAL} />
                  <Text style={[styles.featureText, styles.featureTextGuest]}>
                    Express room delivery available
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          </View>

          {/* TICKETS — BUSINESS ONLY, gated on the same `isBusinessUser` the
              establishment name above uses. This screen is shared with the
              customer stack, and a customer takes no part in the ticket
              system. Quality Issue, Missing Item and Rewash Request are open
              for 48 hours after a delivery; Invoice Issue has no deadline. */}
          {isBusinessUser ? (
            <TouchableOpacity
              style={styles.ticketsEntry}
              onPress={() => navigation.navigate('TicketsScreen')}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Tickets"
            >
              <View style={styles.ticketsIcon}>
                <Ionicons name="ticket-outline" size={22} color={LAUNDRY_TEAL} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.ticketsTitle}>Tickets</Text>
                <Text style={styles.ticketsSubtitle} numberOfLines={1}>
                  Raise and track an issue with an order or invoice
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color={LAUNDRY_TEAL} />
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>

      {/* Swachham AI assistant floating launcher */}
      <SwachhamChatLauncher />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.Background,
  },
  topLogoBannerWrap: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    paddingTop: SPACING.xs,
  },
  topLogoBanner: {
    width: '100%',
    height: 70,
  },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xs,
    paddingBottom: SPACING.xs,
  },
  /* Demo builds only; nothing is rendered here in production. */
  demoBadge: {
    marginBottom: SPACING.xs,
  },
  establishmentName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  userName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  userDivider: {
    height: 1,
    backgroundColor: COLORS.Border,
    marginTop: SPACING.sm,
    width: '100%',
  },
  searchWrap: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    paddingHorizontal: SPACING.md,
    height: 48,
    borderWidth: 1,
    borderColor: COLORS.Border,
    ...SHADOWS.light,
  },
  searchIcon: {
    marginRight: SPACING.sm,
  },
  searchInput: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
    height: '100%',
  },
  resultsArea: {
    flex: 1,
    paddingHorizontal: SPACING.lg,
  },
  resultsList: {
    paddingBottom: SPACING.xxl,
  },
  resultsCount: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextSecondary,
    marginBottom: SPACING.sm,
    marginTop: SPACING.xs,
  },
  serviceResultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.Border,
    ...SHADOWS.light,
  },
  serviceThumb: {
    width: 48,
    height: 48,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
  },
  serviceThumbImage: {
    width: 40,
    height: 40,
  },
  serviceContent: {
    flex: 1,
  },
  serviceName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  serviceCategory: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600',
    color: COLORS.Primary,
    marginTop: 2,
  },
  serviceDescription: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  serviceFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    flexWrap: 'wrap',
    gap: 4,
  },
  servicePrice: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  serviceTypesList: {
    flexDirection: 'row',
    gap: 4,
  },
  serviceTypeBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.xs,
  },
  serviceTypeBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: COLORS.Primary,
    textTransform: 'capitalize',
  },
  chevron: {
    marginLeft: SPACING.xs,
  },
  defaultContent: {
    flex: 1,
  },
  defaultContentInner: {
    paddingHorizontal: SPACING.lg,
    // Clears the floating assistant button, which sits over the bottom-right
    // of this list.
    paddingBottom: SPACING.xxl,
  },
  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '600',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.md,
  },
  list: {
    paddingBottom: SPACING.xxl,
  },
  card: {
    backgroundColor: COLORS.Surface,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    ...SHADOWS.light,
  },
  businessName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  businessAddress: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 4,
  },
  emptyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    marginTop: SPACING.xl,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xxl,
  },
  loadingText: {
    marginTop: SPACING.sm,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  emptyTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginTop: SPACING.sm,
  },
  emptySubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: SPACING.lg,
  },
  searchErrorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    textAlign: 'center',
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.lg,
  },
  retryButton: {
    marginTop: SPACING.md,
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: TYPOGRAPHY.sizes.sm,
  },
  /* The Tickets entry under the two laundry cards. Card-shaped like them, and
     deliberately quieter: it is a way in, not a third laundry type. */
  ticketsEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 14,
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#ffbd4a',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  ticketsIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EAF6F5',
  },
  ticketsTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: '#1B1B1B',
  },
  ticketsSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: '#6B7280',
    marginTop: 2,
  },

  laundryTypeSection: {
    // No bottom margin: the scroll container's own paddingBottom already
    // ends the page, and this margin was pure height the cards needed back.
    // The lg gap BETWEEN the two cards is deliberately untouched — that is
    // the spacing that separates the two choices.
    marginBottom: 0,
  },
  laundryCardsContainer: {
    gap: SPACING.lg,
  },
  laundryCard: {
    backgroundColor: LAUNDRY_TEAL,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 2.5,
    borderColor: LAUNDRY_SAFFRON,
    // Down from lg: 16px either side gives the enlarged title the room it
    // needs to hold "LAUNDRY" on one line on a narrow phone.
    padding: SPACING.md,
    ...SHADOWS.medium,
  },
  /*
   * The Guest card, in the same shape, radius, padding, border weight and
   * saffron border as the Hotel card — only the surface differs, so the two
   * still read as one pair rather than two designs.
   */
  laundryCardGuest: {
    backgroundColor: LAUNDRY_OFF_WHITE,
  },
  // Icon on the left, chevron on the right, nothing between them.
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Solid teal rather than a translucent white, which would vanish on the
  // off-white surface — the saffron icon needs something to sit on.
  iconCircleGuest: {
    backgroundColor: LAUNDRY_TEAL,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    /*
     * `fontSize` and `lineHeight` are set per-render from `cardTitleSize`, not
     * here — they depend on how wide the screen is. See that function, which
     * picks a size the label holds on ONE line.
     *
     * Still no `numberOfLines`: the size is derived to fit rather than the
     * text clamped to fit, so a font this screen renders slightly wider than
     * measured wraps to a second line instead of being truncated.
     *
     * No letterSpacing either — it is width the label cannot spare.
     */
    fontWeight: '900',
    color: '#FFFFFF',
  },
  /*
   * The outline asked for on the Hotel card's title, drawn the only way RN
   * allows: a zero-offset shadow, which lays an even hairline around every
   * glyph instead of dropping it to one side.
   *
   * NOTE THAT #3D6F73 IS ALSO THIS CARD'S BACKGROUND, so the outline is very
   * nearly invisible here — it is the same colour as the surface it is drawn
   * on. Kept as specified; a contrasting colour is a one-line change.
   */
  cardTitleHotel: {
    textShadowColor: '#3D6F73',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 1,
  },
  // The same type in the Guest card's ink. Size and weight are inherited, so
  // the two labels stay identical in everything but colour.
  cardTitleGuest: {
    color: LAUNDRY_TEAL,
  },
  cardTitleUnderline: {
    width: 64,
    height: 4,
    borderRadius: 2,
    backgroundColor: LAUNDRY_SAFFRON,
    // The rule sits close under the title on purpose — it belongs to it, and
    // the height saved is height the second card needs.
    marginTop: SPACING.xs,
  },
  cardTitleUnderlineGuest: {
    backgroundColor: LAUNDRY_TEAL,
  },
  cardSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: '#D8F3DC',
    // Back in tight now the title above it is no longer two lines tall.
    marginTop: SPACING.xs,
  },
  cardSubtitleGuest: {
    color: COLORS.TextSecondary,
  },
  cardDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    // Tightened from md: two cards and a heading have to share one screen.
    marginVertical: SPACING.sm,
  },
  cardDividerGuest: {
    backgroundColor: 'rgba(61, 111, 115, 0.18)',
  },
  cardFeatures: {
    gap: 6,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  featureText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: '#FFFFFF',
    flex: 1,
  },
  featureTextGuest: {
    color: LAUNDRY_TEAL,
  },
});


