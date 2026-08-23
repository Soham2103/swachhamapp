import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Modal,
  Pressable,
  Image,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import SwachhamChatLauncher from '../../components/chat/SwachhamChatLauncher';
import CategoryGridCard from '../../components/business/CategoryGridCard';
import businessOrderApi, { BusinessCategory } from '../../services/businessOrderApi';
import { getCategoryImage } from '../../constants/categoryImages';
import { filterHiddenCategories } from '../../constants/hiddenCategories';
import { extractErrorMessage } from '../../services/api';
import { useBusinessOrderStore } from '../../store/businessOrderStore';

/** Icon fallback per main-category slug, used when no artwork is mapped. */
const CATEGORY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  'room-linen': 'bed-outline',
  'spa-and-pool': 'water-outline',
  'f-and-b-service': 'restaurant-outline',
  'f-and-b-production': 'flame-outline',
  uniforms: 'shirt-outline',
};

/**
 * The two cards whose grid positions are swapped, each listed by every key it
 * may arrive under (slug or display name, lower-cased).
 */
const SWAPPED_CARDS = [
  ['f-and-b-service', 'f&b service'],
  ['uniforms'],
];

/**
 * Swaps the F&B Service and Uniforms cards in the grid, leaving the API's own
 * ordering of everything else untouched. A no-op when either card is absent.
 */
function swapFnbAndUniforms(categories: BusinessCategory[]): BusinessCategory[] {
  const indexOf = (keys: string[]) =>
    categories.findIndex((category) =>
      [category.slug, category.name].some((value) =>
        keys.includes(String(value ?? '').trim().toLowerCase())
      )
    );

  const [first, second] = SWAPPED_CARDS.map(indexOf);
  if (first < 0 || second < 0) return categories;

  const ordered = [...categories];
  [ordered[first], ordered[second]] = [ordered[second], ordered[first]];
  return ordered;
}

const COLUMNS = 2;
const GRID_PADDING = 10;   // screen edge -> card
const GRID_GAP = 10;       // between the two columns
const GRID_ROWS = 2;       // the four main categories, as a 2 x 2 grid
const MIN_CARD_SIZE = 140;

/**
 * Select Items — Main Categories. This is also the Business home page.
 *
 * A 2 x 2 grid of large SQUARE image buttons. The side is the largest square
 * that fits both the screen width and the measured height of the grid area,
 * so the four categories dominate the page, stay square on any device, and
 * are never clipped or overflowed. The block is centred in whatever height is
 * left. Extra categories, if any are ever added, simply scroll at that size.
 *
 * The whole card navigates: to the Sub Category page when the category has
 * children, straight to Items when it does not, so an empty sub-category
 * screen can never appear. Service selection lives on the Items page only.
 */
export default function BusinessCategoriesScreen({ navigation }: any) {
  const [categories, setCategories] = useState<BusinessCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Long-pressing a card previews its full artwork.
  const [zoomed, setZoomed] = useState<BusinessCategory | null>(null);
  const zoomScale = useRef(new Animated.Value(0.85)).current;

  const { width, height } = useWindowDimensions();

  // Height of the area the grid actually gets, measured rather than guessed,
  // so the header and the tab bar are both accounted for on every screen
  // size — and so removing the search bar hands its space straight to the
  // cards instead of leaving a gap.
  const [gridHeight, setGridHeight] = useState(0);

  // The card is square: the largest side that fits two columns across the
  // width AND two rows down the measured height. Width normally wins, so the
  // buttons span the screen; on a short screen the height caps them instead,
  // which is what stops the second row being cut off.
  const cardSize = useMemo(() => {
    const byWidth = Math.floor((width - GRID_PADDING * 2 - GRID_GAP) / COLUMNS);
    if (!gridHeight) return byWidth;
    // Every row carries a bottom margin, the last one included, so all
    // GRID_ROWS gaps come off the usable height.
    const byHeight = Math.floor(
      (gridHeight - GRID_PADDING * 2 - GRID_GAP * GRID_ROWS) / GRID_ROWS
    );
    return Math.max(MIN_CARD_SIZE, Math.min(byWidth, byHeight));
  }, [width, gridHeight]);

  const { cart, loadCart } = useBusinessOrderStore();
  const cartCount = useMemo(
    () => (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  const load = useCallback(async () => {
    try {
      setError('');
      setIsLoading(true);
      const response = await businessOrderApi.getCategories();
      // Hidden purely in the UI — the API and database are left untouched.
      setCategories(swapFnbAndUniforms(filterHiddenCategories(response.data)));
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load categories'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadCart().catch(() => {});
  }, [load, loadCart]);

  const openCategory = (category: BusinessCategory) => {
    if (category.has_subcategories) {
      navigation.navigate('BusinessSubCategoriesScreen', {
        categoryId: category.id,
        categoryName: category.name,
      });
      return;
    }
    navigation.navigate('BusinessItemsScreen', {
      categoryId: category.id,
      categoryName: category.name,
    });
  };

  const openZoom = (category: BusinessCategory) => {
    if (!getCategoryImage(category.slug, category.name) && !category.image_url) return;
    setZoomed(category);
    zoomScale.setValue(0.85);
    Animated.timing(zoomScale, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  const artworkSource = (category: BusinessCategory) => {
    const bundled = getCategoryImage(category.slug, category.name);
    return bundled ?? (category.image_url ? { uri: category.image_url } : null);
  };

  const renderCategory = ({ item }: { item: BusinessCategory }) => (
    <CategoryGridCard
      name={item.name}
      source={artworkSource(item)}
      fallbackIcon={CATEGORY_ICONS[item.slug] || 'cube-outline'}
      size={cardSize}
      onPress={() => openCategory(item)}
      onLongPress={() => openZoom(item)}
    />
  );

  /* The search bar was removed from the Business home screen. The grid
     measures its own height through onLayout below, so it simply reclaims
     the space rather than leaving a gap where the bar used to be. */
  const errorBanner = error ? (
    <View style={styles.errorWrap}>
      <Text style={styles.errorText}>{error}</Text>
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BusinessHeader
        title="Select Items"
        action={
          <TouchableOpacity
            style={styles.cartButton}
            onPress={() => navigation.navigate('BusinessCart')}
          >
            <Ionicons name="cart-outline" size={24} color={COLORS.TextPrimary} />
            {cartCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{cartCount}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        }
      />

      {errorBanner}

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        // The grid owns all the remaining height; onLayout reports it so the
        // cards can be sized to fill it exactly.
        <View
          style={styles.gridArea}
          onLayout={(event) => setGridHeight(event.nativeEvent.layout.height)}
        >
          <FlatList
            data={categories}
            keyExtractor={(item) => item.id}
            renderItem={renderCategory}
            numColumns={COLUMNS}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.gridContent}
            style={styles.gridList}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              error ? (
                <TouchableOpacity style={styles.retryButton} onPress={load}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.emptyText}>No categories available</Text>
              )
            }
          />
        </View>
      )}

      {/* Full artwork preview, opened by long-pressing a card. */}
      <Modal
        visible={zoomed !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setZoomed(null)}
        statusBarTranslucent
      >
        <Pressable style={styles.zoomBackdrop} onPress={() => setZoomed(null)}>
          <Animated.View style={{ transform: [{ scale: zoomScale }] }}>
            <Pressable onPress={() => {}}>
              {zoomed && artworkSource(zoomed) ? (
                <Image
                  source={artworkSource(zoomed)!}
                  style={[
                    styles.zoomImage,
                    {
                      width: Math.min(width * 0.9, height * 0.7),
                      height: Math.min(width * 0.9, height * 0.7),
                    },
                  ]}
                  resizeMode="contain"
                />
              ) : null}
            </Pressable>
          </Animated.View>
          <Text style={styles.zoomCaption}>{zoomed?.name}</Text>
          <TouchableOpacity
            style={styles.zoomClose}
            onPress={() => setZoomed(null)}
            accessibilityLabel="Close image"
          >
            <Ionicons name="close" size={26} color={COLORS.Surface} />
          </TouchableOpacity>
        </Pressable>
      </Modal>

      {/* Swachham assistant, bottom-right and clear of the bottom bar. */}
      <SwachhamChatLauncher />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: GRID_PADDING, paddingBottom: SPACING.xxl },
  // The 2 x 2 grid: no extra bottom padding, so two rows of cards fill the
  // measured area exactly instead of forcing a scroll.
  gridArea: { flex: 1 },
  gridList: { flex: 1 },
  // flexGrow + centre: the square block sits in the middle of whatever height
  // is left over, instead of leaving one dead band at the bottom.
  gridContent: { padding: GRID_PADDING, flexGrow: 1, justifyContent: 'center' },
  row: { gap: GRID_GAP, marginBottom: GRID_GAP, justifyContent: 'center' },
  errorWrap: { paddingHorizontal: GRID_PADDING, paddingTop: SPACING.xs },

  cartButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.Surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.light,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: COLORS.Error,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: COLORS.Surface, fontSize: 11, fontWeight: 'bold' },

  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  emptyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    marginTop: SPACING.lg,
  },
  retryButton: {
    alignSelf: 'center',
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    marginTop: SPACING.md,
  },
  retryButtonText: { color: COLORS.Surface, fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '600' },

  zoomBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomImage: { borderRadius: BORDER_RADIUS.lg },
  zoomCaption: {
    marginTop: SPACING.lg,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.Surface,
  },
  zoomClose: {
    position: 'absolute',
    top: 48,
    right: SPACING.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
