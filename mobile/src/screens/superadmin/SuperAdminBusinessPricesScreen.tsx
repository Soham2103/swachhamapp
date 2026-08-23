import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  TextInput, Modal, Alert, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { sa, STATUS_TONE } from './styles';
import superAdminApi, {
  BusinessPrice, BusinessCompletenessRow, LaundryTypeValue,
} from '../../services/superAdminApi';
import CategoryItemPicker from './CategoryItemPicker';
import { ActionButton } from './SuperAdminCustomerPricesScreen';
import PriceCategoryGroups, { PriceItemRow } from './PriceCategoryGroups';

/**
 * Business Price List — a separate price list per business.
 *
 * Pick a business first, because the price only means anything in the
 * context of one: the same item is ₹30 for one hotel and ₹35 for
 * another, and neither figure is "the" business price.
 *
 * The list includes items that have NO price for this business yet,
 * shown as "Not set". They are the whole reason the screen exists —
 * an unconfigured item blocks that business's orders, so it has to be
 * visible rather than absent.
 *
 * The Customer Price column is the global customer price, for reference
 * only. It is never used as a fallback: the backend refuses to price an
 * order from it.
 *
 * LAUNDRY TYPE. A business pays one rate for its own linen (Hotel Laundry)
 * and another for its guests' clothes (Guest Laundry), so the list shows
 * one type at a time and the selector switches between them. The two are
 * separate rows in the price list: editing one never moves the other.
 *
 * CATEGORY -> SUB-CATEGORY -> ITEMS, and in that order.
 *
 * The list is not shown until a main category is chosen, and — for a category
 * that has sub-categories — until a sub-category is chosen under it. A
 * business's price list runs to a hundred items; picking the sub-category
 * first is how one of them is actually found.
 *
 * The sub-category choices DEPEND on the category above them: only that
 * category's own children are offered, so an impossible pair cannot be
 * selected. The ordering comes from the backend, so the screen shows the
 * catalogue's own order and an item added to a sub-category appears exactly
 * where the backend files it.
 */

/** The two rates a business can be priced at. Fixed by the backend enum. */
const LAUNDRY_TYPES: Array<{ value: LaundryTypeValue; label: string }> = [
  { value: 'hotel', label: 'Hotel Laundry' },
  { value: 'guest', label: 'Guest Laundry' },
];

/*
 * The BUSINESS and the LAUNDRY TYPE are fixed for the whole list -- both are
 * chosen above and every row belongs to them -- so they are stated once in the
 * caption rather than repeated on each row, where they would be forty
 * identical cells. The CATEGORY and SUB-CATEGORY are now the group headings
 * they name, for the same reason: a column that repeats the heading above it
 * is the flat list this screen used to be.
 */
type Filter = 'all' | 'set' | 'unset';

const money = (value: number | null) =>
  value === null || value === undefined ? '—' : `₹${Number(value).toFixed(2)}`;

export default function SuperAdminBusinessPricesScreen({ navigation, route }: any) {
  const [businesses, setBusinesses] = useState<BusinessCompletenessRow[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(route?.params?.businessId ?? null);
  const [picking, setPicking] = useState(false);
  /** Which rate the table is showing. Every row below belongs to this type. */
  const [laundryType, setLaundryType] = useState<LaundryTypeValue>('hotel');
  /** Open when "+ Add New Entry" was pressed rather than a row's edit icon. */
  const [addingNew, setAddingNew] = useState(false);

  const [rows, setRows] = useState<BusinessPrice[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  /** Narrows the table to one top-level category. '' = all. */
  const [categoryFilter, setCategoryFilter] = useState('');
  /** Narrows further, to one sub-category of it. '' = all. Dependent. */
  const [subcategoryFilter, setSubcategoryFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [editing, setEditing] = useState<BusinessPrice | null>(null);

  const business = businesses.find((b) => b.business_id === businessId) || null;

  const loadBusinesses = useCallback(async () => {
    try {
      const list = await superAdminApi.listBusinesses(false);
      setBusinesses(list);
      // Opening straight into a list is more useful than an empty screen
      // when there is only one business to choose from.
      if (!businessId && list.length === 1) setBusinessId(list[0].business_id);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load businesses');
    }
  }, [businessId]);

  // Re-fetched whenever the business OR the laundry type changes: the two
  // together decide which price list is being looked at.
  const loadPrices = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    setError('');
    try {
      setRows(await superAdminApi.getBusinessPrices(businessId, laundryType));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load the price list');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [businessId, laundryType]);

  useFocusEffect(useCallback(() => { loadBusinesses(); }, [loadBusinesses]));
  React.useEffect(() => { loadPrices(); }, [loadPrices]);

  const unsetCount = useMemo(() => rows.filter((row) => row.price === null).length, [rows]);

  /** The top-level categories present in this business's list, for the chips. */
  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      // Fall back to the item's own category when it has no parent — a flat
      // category IS the top level.
      const id = row.parent_category_id || row.category_id;
      const name = row.parent_category_name || row.category_name;
      if (id && name && !seen.has(id)) seen.set(id, name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [rows]);

  /** The sub-categories of the chosen category, and only those. */
  const subcategoryOptions = useMemo(() => {
    if (!categoryFilter) return [];
    const seen = new Map<string, string>();
    for (const row of rows) {
      if (row.parent_category_id !== categoryFilter) continue;
      if (row.category_id && row.category_name && !seen.has(row.category_id)) {
        seen.set(row.category_id, row.category_name);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [rows, categoryFilter]);

  /** Changing the category clears the sub-category below it. */
  const chooseCategory = (id: string) => {
    setCategoryFilter(id);
    setSubcategoryFilter('');
  };

  /**
   * Whether the two-step choice has been made.
   *
   * A category is always required. A sub-category is required as well WHENEVER
   * the chosen category has any — a category whose items sit directly on it
   * has none to choose, and waiting for one would leave its items unreachable.
   */
  const readyToList =
    categoryFilter !== '' && (subcategoryOptions.length === 0 || subcategoryFilter !== '');

  const shown = useMemo(() => {
    // Nothing until Category -> Sub-category has been answered.
    if (!readyToList) return [];
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === 'set' && row.price === null) return false;
      if (filter === 'unset' && row.price !== null) return false;
      if (categoryFilter) {
        const id = row.parent_category_id || row.category_id;
        if (id !== categoryFilter) return false;
      }
      if (subcategoryFilter && row.category_id !== subcategoryFilter) return false;
      if (!needle) return true;
      return (
        row.item_name.toLowerCase().includes(needle) ||
        (row.category_name || '').toLowerCase().includes(needle) ||
        (row.parent_category_name || '').toLowerCase().includes(needle)
      );
    });
  }, [rows, search, filter, categoryFilter, subcategoryFilter, readyToList]);

  const toggleActive = async (row: BusinessPrice) => {
    if (!businessId || !row.id) return;
    try {
      await superAdminApi.updateBusinessPrice(businessId, row.id, { is_active: !row.is_active });
      loadPrices();
    } catch (e: any) {
      Alert.alert('Could not update', e?.response?.data?.message || e.message);
    }
  };

  const confirmDelete = (row: BusinessPrice) => {
    if (!businessId || !row.id) return;
    Alert.alert(
      'Remove this price?',
      `${row.item_name} · ${row.laundry_type_label} — ${money(row.price)} for ` +
        `${business?.business_name || 'this business'}.\n\n` +
        'Only this laundry type is affected; the other one keeps its own price. ' +
        'Past orders keep the price they were placed at. Without a price, this ' +
        'business cannot order the item at this laundry type until one is set again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disable',
          onPress: async () => {
            try {
              await superAdminApi.deleteBusinessPrice(businessId, row.id!);
              loadPrices();
            } catch (e: any) {
              Alert.alert('Could not disable', e?.response?.data?.message || e.message);
            }
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await superAdminApi.deleteBusinessPrice(businessId, row.id!, true);
              loadPrices();
            } catch (e: any) {
              Alert.alert('Could not delete', e?.response?.data?.message || e.message);
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
        <Text style={sa.headerTitle}>Business Price List</Text>
      </View>

      {/* Select Business, first and always visible: every figure below
          belongs to exactly one business. */}
      <View style={{ paddingHorizontal: SPACING.md }}>
        <Text style={sa.label}>SELECT BUSINESS</Text>
        <TouchableOpacity
          style={[sa.input, { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }]}
          onPress={() => setPicking(true)}
          accessibilityLabel="Select a business"
        >
          <Ionicons name="business-outline" size={18} color={COLORS.Primary} />
          <Text
            style={{
              flex: 1,
              fontFamily: TYPOGRAPHY.fontFamily,
              fontSize: TYPOGRAPHY.sizes.base,
              color: business ? COLORS.TextPrimary : COLORS.TextSecondary,
            }}
            numberOfLines={1}
          >
            {business ? business.business_name : 'Choose a business'}
          </Text>
          <Ionicons name="chevron-down" size={18} color={COLORS.TextSecondary} />
        </TouchableOpacity>
      </View>

      {!businessId ? (
        <Text style={sa.empty}>Select a business to see and edit its prices.</Text>
      ) : (
        <>
          {/* Laundry type. Hotel and Guest are priced separately, so the
              table shows one at a time and this switches between them. */}
          <View style={{ paddingHorizontal: SPACING.md }}>
            <Text style={sa.label}>LAUNDRY TYPE</Text>
            <View style={{ flexDirection: 'row', gap: SPACING.xs }}>
              {LAUNDRY_TYPES.map((type) => {
                const on = laundryType === type.value;
                return (
                  <TouchableOpacity
                    key={type.value}
                    style={[sa.tab, on && sa.tabActive, { flex: 1 }]}
                    onPress={() => {
                      setLaundryType(type.value);
                      setFilter('all');
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[sa.tabText, on && sa.tabTextActive]}>{type.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* The explicit way in. Adding is its own action rather than only
              being reachable by finding a "Not set" row in the table. */}
          <TouchableOpacity
            style={[
              sa.addEntryBtn,
              { marginTop: SPACING.md, marginHorizontal: SPACING.md },
            ]}
            onPress={() => setAddingNew(true)}
            accessibilityLabel="Add new price entry"
          >
            <Ionicons name="add" size={20} color={COLORS.Surface} />
            <Text style={sa.addEntryText}>Add New Entry</Text>
          </TouchableOpacity>

          <View style={{ paddingHorizontal: SPACING.md, paddingTop: SPACING.sm }}>
            <TextInput
              style={sa.input}
              placeholder="Search items"
              placeholderTextColor={COLORS.TextSecondary}
              value={search}
              onChangeText={setSearch}
            />
          </View>

          <View style={[sa.tabs, { paddingTop: SPACING.sm }]}>
            <FilterTab label={`All (${rows.length})`} on={filter === 'all'} onPress={() => setFilter('all')} />
            <FilterTab
              label={`Priced (${rows.length - unsetCount})`}
              on={filter === 'set'}
              onPress={() => setFilter('set')}
            />
            <FilterTab
              label={`Not set (${unsetCount})`}
              on={filter === 'unset'}
              onPress={() => setFilter('unset')}
            />
          </View>

          {/* STEP 1 — Category. Required: there is no "all", because showing
              every item at once is the thing this replaces. Horizontally
              scrolling, so any number of categories costs one row of height. */}
          <Text style={[sa.label, { paddingHorizontal: SPACING.md }]}>CATEGORY</Text>
          {categoryOptions.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={sa.filterBar}
            >
              {categoryOptions.map((c) => {
                const on = categoryFilter === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={[sa.filterChip, on && sa.filterChipOn]}
                    onPress={() => chooseCategory(on ? '' : c.id)}
                  >
                    <Text style={[sa.filterChipText, on && sa.filterChipTextOn]}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* STEP 2 — Sub-category. DEPENDENT on the category above: it
              appears only once one is chosen, and lists only that category's
              children, so a pair that does not exist cannot be selected. */}
          {categoryFilter && subcategoryOptions.length > 0 && (
            <>
            <Text style={[sa.label, { paddingHorizontal: SPACING.md }]}>SUB CATEGORY</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={sa.filterBar}
            >
              {subcategoryOptions.map((c) => {
                const on = subcategoryFilter === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={[sa.filterChip, on && sa.filterChipOn]}
                    onPress={() => setSubcategoryFilter(on ? '' : c.id)}
                  >
                    <Text style={[sa.filterChipText, on && sa.filterChipTextOn]}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            </>
          )}

          {unsetCount > 0 && (
            <View style={[sa.warnBox, { marginHorizontal: SPACING.md }]}>
              <Ionicons name="alert-circle-outline" size={16} color="#8A5200" />
              <Text style={sa.warnText}>
                {unsetCount} item{unsetCount === 1 ? '' : 's'} have no{' '}
                {LAUNDRY_TYPES.find((t) => t.value === laundryType)?.label} price for this
                business. Orders at this laundry type containing them will be refused.
              </Text>
            </View>
          )}

          {loading ? (
            <View style={sa.centered}>
              <ActivityIndicator size="large" color={COLORS.Primary} />
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={sa.scroll}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => { setRefreshing(true); loadPrices(); }}
                />
              }
            >
              {!!error && (
                <View style={sa.errorBox}>
                  <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                  <Text style={sa.errorText}>{error}</Text>
                </View>
              )}

              {!readyToList ? (
                /* The prompt, not an error: nothing has gone wrong, a choice
                   has simply not been made yet. It names the missing step. */
                <Text style={sa.empty}>
                  {categoryFilter === ''
                    ? 'Choose a category to see its items.'
                    : 'Choose a sub-category to see its items.'}
                </Text>
              ) : shown.length === 0 ? (
                <Text style={sa.empty}>Nothing matches that filter.</Text>
              ) : (
                /* Main Category -> Sub-category -> Items. The category and
                   sub-category are the headings, so each row carries only what
                   is actually specific to it: the item, its rates, and what can
                   be done to it. Every group opens while a search or filter is
                   narrowing the list. */
                <PriceCategoryGroups
                  rows={shown}
                  keyOf={(row) => String(row.item_id)}
                  topIdOf={(row) => row.parent_category_id || row.category_id}
                  topNameOf={(row) => row.parent_category_name || row.category_name}
                  subIdOf={(row) => (row.parent_category_id ? row.category_id : null)}
                  subNameOf={(row) => (row.parent_category_id ? row.category_name : null)}
                  expandAll={
                    search.trim() !== '' ||
                    filter !== 'all' ||
                    categoryFilter !== '' ||
                    subcategoryFilter !== ''
                  }
                  renderItem={(row) => (
                    <PriceItemRow
                      title={row.item_name}
                      subtitle={
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: SPACING.xs,
                            marginTop: 2,
                          }}
                        >
                          {/* The reference figure, never a fallback: the
                              backend refuses to price an order from it. */}
                          <Text style={sa.tdMuted}>
                            Customer: {money(row.customer_price)}
                          </Text>
                          {row.price === null ? null : <StatusPill active={row.is_active} />}
                          {!row.item_is_active ? (
                            <Text style={[sa.tdMuted, { color: COLORS.Warning, fontSize: 10 }]}>
                              item disabled
                            </Text>
                          ) : null}
                        </View>
                      }
                      right={
                        row.price === null ? (
                          <Text style={[sa.tdPrice, { color: COLORS.Warning }]}>Not set</Text>
                        ) : (
                          <Text style={sa.tdPrice}>{money(row.price)}</Text>
                        )
                      }
                      actions={
                        <>
                          <ActionButton
                            icon={row.price === null ? 'add-circle-outline' : 'create-outline'}
                            label={row.price === null ? 'Set' : 'Adjust'}
                            tone="primary"
                            onPress={() => setEditing(row)}
                            accessibilityLabel={
                              row.price === null
                                ? `Set price for ${row.item_name}`
                                : `Adjust price for ${row.item_name}`
                            }
                          />
                          {/* Enable/Disable and Delete need a row to act on:
                              an item with no price for this business has
                              nothing to enable or remove yet. */}
                          {row.id !== null && (
                            <>
                              <ActionButton
                                icon={
                                  row.is_active
                                    ? 'close-circle-outline'
                                    : 'checkmark-circle-outline'
                                }
                                label={row.is_active ? 'Disable' : 'Enable'}
                                onPress={() => toggleActive(row)}
                                accessibilityLabel={
                                  row.is_active
                                    ? `Disable price for ${row.item_name}`
                                    : `Enable price for ${row.item_name}`
                                }
                              />
                              <ActionButton
                                icon="trash-outline"
                                label="Delete"
                                tone="danger"
                                onPress={() => confirmDelete(row)}
                                accessibilityLabel={`Remove price for ${row.item_name}`}
                              />
                            </>
                          )}
                        </>
                      }
                    />
                  )}
                />
              )}
            </ScrollView>
          )}
        </>
      )}

      {/* Business picker */}
      <Modal visible={picking} animationType="slide" transparent onRequestClose={() => setPicking(false)}>
        <View style={sa.modalBackdrop}>
          <View style={sa.modalSheet}>
            <View style={sa.header}>
              <Text style={[sa.headerTitle, { flex: 1 }]}>Select business</Text>
              <TouchableOpacity style={sa.iconBtn} onPress={() => setPicking(false)}>
                <Ionicons name="close" size={22} color={COLORS.TextPrimary} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={sa.scroll}>
              {businesses.length === 0 && <Text style={sa.empty}>No businesses yet.</Text>}
              {businesses.map((b) => (
                <TouchableOpacity
                  key={b.business_id}
                  style={[sa.choice, businessId === b.business_id && sa.choiceActive]}
                  onPress={() => {
                    setBusinessId(b.business_id);
                    setPicking(false);
                  }}
                >
                  <Ionicons
                    name={businessId === b.business_id ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={businessId === b.business_id ? COLORS.Primary : COLORS.TextSecondary}
                  />
                  <Text style={sa.choiceText} numberOfLines={1}>{b.business_name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <BusinessPriceModal
        businessId={businessId}
        businessName={business?.business_name || ''}
        laundryType={laundryType}
        laundryTypeLabel={LAUNDRY_TYPES.find((t) => t.value === laundryType)?.label || ''}
        row={editing}
        /* "+ Add New Entry" opens the same sheet with no row, which is what
           turns on the item picker inside it. */
        addingNew={addingNew}
        /* Items already priced at THIS laundry type, so the picker can leave
           them out — adding one again would only 409. */
        pricedItemIds={rows.filter((r) => r.price !== null).map((r) => r.item_id)}
        onClose={() => { setEditing(null); setAddingNew(false); }}
        onSaved={() => { setEditing(null); setAddingNew(false); loadPrices(); }}
      />
    </SafeAreaView>
  );
}

function FilterTab({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[sa.tab, on && sa.tabActive]} onPress={onPress}>
      <Text style={[sa.tabText, on && sa.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatusPill({ active }: { active: boolean }) {
  const tone = active ? STATUS_TONE.ACTIVE : STATUS_TONE.INACTIVE;
  return (
    <View style={[sa.pill, { backgroundColor: tone.bg }]}>
      <Text style={[sa.pillText, { color: tone.fg }]}>{active ? 'ACTIVE' : 'DISABLED'}</Text>
    </View>
  );
}

/* ===================================================================
 * SET / EDIT ONE BUSINESS PRICE
 * =================================================================== */

interface ModalProps {
  businessId: string | null;
  businessName: string;
  laundryType: LaundryTypeValue;
  laundryTypeLabel: string;
  row: BusinessPrice | null;
  /** True when opened by "+ Add New Entry" rather than by a row's action. */
  addingNew: boolean;
  /** Already priced at this laundry type — excluded from the picker. */
  pricedItemIds: string[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Sets this business's price for one item at one laundry type.
 *
 * Three jobs, one sheet: change an existing price (PUT), set the price of a
 * row that shows "Not set" (POST), and "+ Add New Entry", which is the same
 * POST reached by picking the item here instead of finding it in the table.
 *
 * The laundry type is fixed by the table the sheet was opened from and is
 * shown, not chosen again — that is what stops a Guest price being saved
 * while the Hotel table is on screen.
 */
function BusinessPriceModal({
  businessId,
  businessName,
  laundryType,
  laundryTypeLabel,
  row,
  addingNew,
  pricedItemIds,
  onClose,
  onSaved,
}: ModalProps) {
  const [price, setPrice] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Only used by the "+ Add New Entry" path, where no row was given. */
  const [pickedItemId, setPickedItemId] = useState<string>('');
  const [pickedItemName, setPickedItemName] = useState<string>('');

  const visible = row !== null || addingNew;

  React.useEffect(() => {
    if (!visible) return;
    setError('');
    setPickedItemName('');
    if (row) {
      setPrice(row.price === null ? '' : String(row.price));
      setActive(row.id === null ? true : row.is_active);
      setPickedItemId(row.item_id);
    } else {
      setPrice('');
      setActive(true);
      setPickedItemId('');
    }
  }, [visible, row]);

  const save = async () => {
    if (!businessId) return;
    const itemId = row ? row.item_id : pickedItemId;
    if (!itemId) return;

    setBusy(true);
    setError('');
    try {
      if (row?.id) {
        await superAdminApi.updateBusinessPrice(businessId, row.id, {
          price,
          is_active: active,
        });
      } else {
        // The laundry type comes from the table that was open, never from a
        // second control here, so what is saved is what was on screen.
        await superAdminApi.createBusinessPrice(businessId, {
          item_id: itemId,
          laundry_type: laundryType,
          price,
          is_active: active,
        });
      }
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>
              {row?.id ? 'Edit business price' : 'Add price entry'}
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

            {row ? (
              <View style={sa.card}>
                <Text style={sa.cardTitle}>{row.item_name}</Text>
                <Text style={sa.cardMeta}>
                  {businessName} · {laundryTypeLabel}
                </Text>
                {/* Reference only. Stated as such, so it is never mistaken
                    for a value this business will be charged. */}
                <Text style={sa.cardLine}>
                  Customer price: {money(row.customer_price)}{' '}
                  <Text style={sa.tdMuted}>(reference only — not used for this business)</Text>
                </Text>
              </View>
            ) : (
              <>
                <View style={sa.card}>
                  <Text style={sa.cardTitle}>{businessName}</Text>
                  {/* The type is stated, not chosen again: it is whichever
                      table this sheet was opened from. */}
                  <Text style={sa.cardMeta}>{laundryTypeLabel}</Text>
                  {/* What has been chosen so far, so the price field below is
                      never entered against a forgotten item. */}
                  {pickedItemName ? (
                    <Text style={sa.cardLine}>Item: {pickedItemName}</Text>
                  ) : null}
                </View>

                {/* Category -> Sub-category -> Item, dependent. Items already
                    priced at this laundry type are left out, so a selection
                    here can never produce a duplicate. */}
                <CategoryItemPicker
                  excludeItemIds={pricedItemIds}
                  selectedItemId={pickedItemId}
                  onSelectItem={(id, item) => {
                    setPickedItemId(id);
                    setPickedItemName(item?.name || '');
                  }}
                />
              </>
            )}

            <Text style={sa.label}>
              {laundryTypeLabel.toUpperCase()} PRICE (₹) <Text style={sa.required}>*</Text>
            </Text>
            <TextInput
              style={sa.input}
              placeholder="0.00"
              placeholderTextColor={COLORS.TextSecondary}
              keyboardType="decimal-pad"
              value={price}
              onChangeText={setPrice}
              /* Focused only when the item is already settled; on the add
                 path the item picker comes first. */
              autoFocus={Boolean(row)}
            />

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginTop: SPACING.md,
                gap: SPACING.sm,
              }}
            >
              <Switch
                value={active}
                onValueChange={setActive}
                trackColor={{ true: COLORS.PrimaryLight, false: COLORS.Border }}
                thumbColor={active ? COLORS.Primary : COLORS.Surface}
              />
              <Text
                style={{
                  flex: 1,
                  fontFamily: TYPOGRAPHY.fontFamily,
                  fontSize: TYPOGRAPHY.sizes.sm,
                  color: COLORS.TextPrimary,
                }}
              >
                {active
                  ? `Active — billed at this price for ${laundryTypeLabel}`
                  : 'Disabled — orders with this item at this laundry type will be refused'}
              </Text>
            </View>

            <TouchableOpacity
              style={[
                sa.button,
                (price.trim() === '' || (!row && !pickedItemId) || busy) && sa.buttonDisabled,
              ]}
              onPress={save}
              disabled={price.trim() === '' || (!row && !pickedItemId) || busy}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.Surface} />
              ) : (
                <Text style={sa.buttonText}>Save price</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={sa.buttonGhost} onPress={onClose}>
              <Text style={sa.buttonGhostText}>Cancel</Text>
            </TouchableOpacity>

            <View style={{ height: BORDER_RADIUS.xxl }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
