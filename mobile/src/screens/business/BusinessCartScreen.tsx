import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import {
  useBusinessOrderStore,
  SERVICE_OPTIONS,
  ORDER_TYPE_OPTIONS,
  ORDER_TYPE_REQUIRED_MESSAGE,
  LAUNDRY_TYPE_OPTIONS,
  LAUNDRY_TYPE_REQUIRED_MESSAGE,
  CART_ITEM_SERVICE_REQUIRED_MESSAGE,
  CART_EMPTY_MESSAGE,
  LaundryType,
  OrderType,
} from '../../store/businessOrderStore';
import { formatWeightKg } from '../../utils/businessOrderPdf';

const ORDER_TYPE_ICONS: Record<OrderType, keyof typeof Ionicons.glyphMap> = {
  standard: 'time-outline',
  quick: 'flash-outline',
};

const LAUNDRY_TYPE_ICONS: Record<LaundryType, keyof typeof Ionicons.glyphMap> = {
  hotel: 'business-outline',
  guest: 'person-outline',
};

/**
 * Cart / Order Confirmation.
 *
 * Two selections are made here and nowhere else: Order Type (Standard/Quick)
 * and Laundry Type (Hotel/Guest). Both are compulsory. There is deliberately
 * no order-wide laundry service section — the service belongs to each line,
 * chosen on the Items page, and is only displayed (and switchable) per item.
 */
export default function BusinessCartScreen({ navigation }: any) {
  const {
    cart,
    isLoading,
    laundryType,
    orderType,
    saveOrderType,
    saveLaundryType,
    loadCart,
    updateItem,
    setItemService,
    removeItem,
  } = useBusinessOrderStore();
  const [error, setError] = useState('');
  const [initialLoad, setInitialLoad] = useState(true);

  const items = cart?.items || [];
  /** Blocks Continue until every line carries its own service. */
  const hasItemWithoutService = items.some((item) => !item.service_type);

  const refresh = useCallback(() => {
    loadCart()
      .catch((err: any) => setError(err?.message || 'Failed to load cart'))
      .finally(() => setInitialLoad(false));
  }, [loadCart]);

  // Reloading on focus is what makes Repeat Order land on a populated cart.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', refresh);
    refresh();
    return unsubscribe;
  }, [navigation, refresh]);

  // No location code on this screen, and none on the Time Slot page either:
  // the service area was settled on the Allow Permission page when the app
  // opened, and ordering neither asks for a fix nor re-tests the district.

  const handleUpdateQuantity = async (itemId: string, quantity: number) => {
    if (quantity < 1) return;
    try {
      setError('');
      await updateItem(itemId, quantity);
    } catch (err: any) {
      setError(err?.message || 'Failed to update quantity');
    }
  };

  /** Each line keeps its own service, independent of the other lines. */
  const handleItemService = async (itemId: string, value: string) => {
    try {
      setError('');
      await setItemService(itemId, value);
    } catch (err: any) {
      setError(err?.message || 'Failed to change item service');
    }
  };

  const handleRemove = async (itemId: string) => {
    try {
      setError('');
      await removeItem(itemId);
    } catch (err: any) {
      setError(err?.message || 'Failed to remove item');
    }
  };

  /** Order type is stored on the cart and travels onto the order from there. */
  const handleSelectOrderType = async (value: OrderType) => {
    try {
      setError('');
      await saveOrderType(value);
    } catch (err: any) {
      setError(err?.message || 'Failed to select order type');
    }
  };

  /** Laundry type, the second compulsory Cart selection. */
  const handleSelectLaundryType = async (value: LaundryType) => {
    try {
      setError('');
      await saveLaundryType(value);
    } catch (err: any) {
      setError(err?.message || 'Failed to select laundry type');
    }
  };

  /**
   * Cart -> Time Slot.
   *
   * The cart validates what belongs to the cart and nothing more; the day and
   * the two slots are chosen on the next page, which is also where the order
   * is finally placed. Navigating there leaves this screen mounted, so the
   * items and quantities are exactly as they were on the way back.
   */
  const handleContinue = () => {
    if (items.length === 0) {
      setError(CART_EMPTY_MESSAGE);
      return;
    }
    if (items.some((item) => !item.service_type)) {
      setError(CART_ITEM_SERVICE_REQUIRED_MESSAGE);
      return;
    }
    if (!orderType) {
      setError(ORDER_TYPE_REQUIRED_MESSAGE);
      return;
    }
    if (!laundryType) {
      setError(LAUNDRY_TYPE_REQUIRED_MESSAGE);
      return;
    }

    setError('');
    navigation.navigate('BusinessTimeSlotScreen');
  };

  // Order Type: compulsory, exactly one.
  const orderTypeSection = (
    <View style={styles.serviceCard}>
      <Text style={styles.serviceTitle}>
        Order Type <Text style={styles.required}>*</Text>
      </Text>
      <Text style={styles.serviceHint}>Select one order type for this order</Text>

      {ORDER_TYPE_OPTIONS.map((option) => {
        const isSelected = orderType === option.value;
        return (
          <TouchableOpacity
            key={option.value}
            style={[styles.serviceOption, isSelected && styles.serviceOptionSelected]}
            onPress={() => handleSelectOrderType(option.value)}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
          >
            <View style={[styles.serviceIcon, isSelected && styles.serviceIconSelected]}>
              <Ionicons
                name={ORDER_TYPE_ICONS[option.value]}
                size={20}
                color={isSelected ? COLORS.Surface : COLORS.Primary}
              />
            </View>
            <Text style={[styles.serviceLabel, isSelected && styles.serviceLabelSelected]}>
              {option.label}
            </Text>
            {isSelected ? (
              <Ionicons name="checkmark-circle" size={22} color={COLORS.Primary} />
            ) : (
              <View style={styles.radioOuter} />
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // Laundry Type: compulsory, exactly one. Asked here rather than before the
  // catalogue, so the Cart is the single place it is chosen.
  const laundryTypeSection = (
    <View style={styles.serviceCard}>
      <Text style={styles.serviceTitle}>
        Laundry Type <Text style={styles.required}>*</Text>
      </Text>
      <Text style={styles.serviceHint}>Select one laundry type for this order</Text>

      {LAUNDRY_TYPE_OPTIONS.map((option) => {
        const isSelected = laundryType === option.value;
        return (
          <TouchableOpacity
            key={option.value}
            style={[styles.serviceOption, isSelected && styles.serviceOptionSelected]}
            onPress={() => handleSelectLaundryType(option.value)}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
          >
            <View style={[styles.serviceIcon, isSelected && styles.serviceIconSelected]}>
              <Ionicons
                name={LAUNDRY_TYPE_ICONS[option.value]}
                size={20}
                color={isSelected ? COLORS.Surface : COLORS.Primary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.serviceLabel,
                  styles.serviceLabelStacked,
                  isSelected && styles.serviceLabelSelected,
                ]}
              >
                {option.label}
              </Text>
              <Text style={styles.serviceOptionHint}>{option.hint}</Text>
            </View>
            {isSelected ? (
              <Ionicons name="checkmark-circle" size={22} color={COLORS.Primary} />
            ) : (
              <View style={styles.radioOuter} />
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Back is always offered. The Cart is a tab root, so there is usually
          nothing on its own stack to pop — in that case it returns to Select
          Items, which is where the user came from. Navigating away never
          touches the cart: it lives on the server and in the store, so every
          item and quantity is still there on return. */}
      <BusinessHeader
        title="My Cart"
        onBack={() =>
          navigation.canGoBack() ? navigation.goBack() : navigation.navigate('BusinessHome')
        }
      />

      {initialLoad ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <>
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            /* The two compulsory selections are the FIRST thing on the page:
               they are the list header, so they sit above the cart items and
               are on screen the moment the Cart opens — with an empty cart
               too. */
            ListHeaderComponent={
              <>
                {orderTypeSection}
                {laundryTypeSection}
                {items.length > 0 ? <Text style={styles.itemsHeading}>Cart Items</Text> : null}
              </>
            }
            ListEmptyComponent={
              <View style={styles.emptyBlock}>
                <Ionicons name="cart-outline" size={48} color={COLORS.TextSecondary} />
                <Text style={styles.emptyText}>Your cart is empty</Text>
                <TouchableOpacity
                  style={styles.browseButton}
                  onPress={() => navigation.navigate('BusinessHome')}
                >
                  <Text style={styles.browseButtonText}>Browse Items</Text>
                </TouchableOpacity>
              </View>
            }
            renderItem={({ item }) => (
              <View style={styles.itemCard}>
                <View style={styles.itemImagePlaceholder}>
                  {item.image_url ? (
                    <Image
                      source={{ uri: item.image_url }}
                      style={styles.itemImageInner}
                      resizeMode="contain"
                    />
                  ) : (
                    <Ionicons name="shirt-outline" size={24} color={COLORS.Primary} />
                  )}
                </View>
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName}>{item.item_name}</Text>
                  {/* Unit weight comes from the catalogue; the line total is
                      that weight multiplied by the quantity. */}
                  <Text style={styles.itemMeta}>
                    {item.category_name} · {item.unit} · {formatWeightKg(item.weight_kg)} ×{' '}
                    {item.quantity} = {formatWeightKg(item.total_weight_kg)}
                  </Text>

                  {/* This line's own service — the only place a service is
                      shown in the Cart. Only the services the item supports
                      are offered, so a switch can never be invalid, and
                      changing one line never touches another. */}
                  <Text style={styles.itemServiceLabel}>
                    Service:{' '}
                    <Text style={styles.itemServiceValue}>
                      {item.service_type
                        ? SERVICE_OPTIONS.find((o) => o.value === item.service_type)?.label ||
                          item.service_name ||
                          item.service_type
                        : 'Not selected'}
                    </Text>
                  </Text>
                  <View style={styles.itemServiceRow}>
                    {(item.available_service_types.length > 0
                      ? item.available_service_types
                      : item.service_type
                      ? [item.service_type]
                      : []
                    ).map((code) => {
                      const isSelected = item.service_type === code;
                      const label = SERVICE_OPTIONS.find((o) => o.value === code)?.label || code;
                      return (
                        <TouchableOpacity
                          key={code}
                          style={[styles.itemServiceChip, isSelected && styles.itemServiceChipSelected]}
                          onPress={() => handleItemService(item.item_id, code)}
                          disabled={isLoading || isSelected}
                          activeOpacity={0.8}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: isSelected }}
                        >
                          <Text
                            style={[
                              styles.itemServiceChipText,
                              isSelected && styles.itemServiceChipTextSelected,
                            ]}
                          >
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {!item.service_type ? (
                    <Text style={styles.itemServiceMissing}>
                      Select a laundry service for this item.
                    </Text>
                  ) : null}

                  <View style={styles.itemActions}>
                    <View style={styles.stepper}>
                      <TouchableOpacity
                        style={styles.stepperButton}
                        onPress={() => handleUpdateQuantity(item.item_id, item.quantity - 1)}
                        disabled={isLoading}
                      >
                        <Ionicons name="remove" size={16} color={COLORS.Primary} />
                      </TouchableOpacity>
                      <Text style={styles.stepperValue}>{item.quantity}</Text>
                      <TouchableOpacity
                        style={styles.stepperButton}
                        onPress={() => handleUpdateQuantity(item.item_id, item.quantity + 1)}
                        disabled={isLoading}
                      >
                        <Ionicons name="add" size={16} color={COLORS.Primary} />
                      </TouchableOpacity>
                    </View>

                    <TouchableOpacity onPress={() => handleRemove(item.item_id)} disabled={isLoading}>
                      <Ionicons name="trash-outline" size={20} color={COLORS.Error} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}
          />

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Order summary and Confirm belong to a cart that has items. */}
          {items.length > 0 ? (
            <>
              {/* Weight, not price — the Business flow never surfaces amounts. */}
              <View style={styles.weightRow}>
                <Text style={styles.weightLabel}>Items</Text>
                <Text style={styles.weightValue}>{items.length}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Weight</Text>
                <Text style={styles.summaryValue}>{formatWeightKg(cart?.total_weight_kg)}</Text>
              </View>

              {/* Continue, not Confirm: the order is placed on the Time
                  Slot page once the day and both slots are chosen. */}
              <TouchableOpacity
                style={[
                  styles.confirmButton,
                  (!orderType || !laundryType || hasItemWithoutService) &&
                    styles.confirmButtonDisabled,
                ]}
                onPress={handleContinue}
                activeOpacity={0.8}
              >
                <Text style={styles.confirmButtonText}>Continue</Text>
                <Ionicons name="arrow-forward" size={20} color={COLORS.Surface} />
              </TouchableOpacity>
            </>
          ) : null}
        </>
      )}

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  emptyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    marginTop: SPACING.sm,
    marginBottom: SPACING.lg,
  },
  browseButton: {
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
  },
  browseButtonText: { color: COLORS.Surface, fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '600' },
  // Empty cart, shown below the two selection cards rather than instead of
  // them, so the selections stay the first thing on the page.
  emptyBlock: { alignItems: 'center', paddingVertical: SPACING.xl },
  itemsHeading: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.xs,
  },
  summaryLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  summaryValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  summaryValueMissing: { color: COLORS.Error },

  weightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },
  weightLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  weightValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
  errorText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
  },
  listContent: { padding: SPACING.md },
  itemCard: {
    flexDirection: 'row',
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  itemImagePlaceholder: {
    width: 48,
    height: 48,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Background,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
    overflow: 'hidden',
  },
  itemImageInner: { width: '100%', height: '100%' },
  itemInfo: { flex: 1 },
  itemName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  itemMeta: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
    marginBottom: SPACING.sm,
  },
  // Per-line service, in the same surface/border/primary language as the
  // Order Type and Laundry Type options below the list.
  itemServiceLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginBottom: 4,
  },
  itemServiceValue: { fontWeight: '700', color: COLORS.PrimaryDark },
  itemServiceMissing: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Error,
    marginBottom: SPACING.sm,
  },
  itemServiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginBottom: SPACING.sm },
  itemServiceChip: {
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
  },
  itemServiceChipSelected: { borderColor: COLORS.Primary, backgroundColor: COLORS.Accent + '25' },
  itemServiceChipText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    color: COLORS.TextSecondary,
  },
  itemServiceChipTextSelected: { color: COLORS.PrimaryDark, fontWeight: '700' },
  itemActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.sm,
  },
  stepperButton: { padding: SPACING.xs, width: 30, alignItems: 'center' },
  stepperValue: {
    width: 28,
    textAlign: 'center',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },

  // ---- Order Type + Laundry Type, the two compulsory Cart selections ----
  serviceCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  serviceTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  required: { color: COLORS.Error },
  serviceHint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginBottom: SPACING.sm,
  },
  serviceOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderWidth: 2,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  serviceOptionSelected: { borderColor: COLORS.Primary, backgroundColor: COLORS.Accent + '18' },
  serviceIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.Background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceIconSelected: { backgroundColor: COLORS.Primary },
  serviceLabel: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  // Used when the label sits above a hint inside its own column, where the
  // row-level flex would otherwise stretch it.
  serviceLabelStacked: { flex: 0 },
  serviceLabelSelected: { color: COLORS.PrimaryDark },
  serviceOptionHint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.Border,
  },

  confirmButton: {
    height: 55,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.medium,
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.md,
  },
  confirmButtonDisabled: { opacity: 0.6 },
  confirmButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.Surface,
  },
});
