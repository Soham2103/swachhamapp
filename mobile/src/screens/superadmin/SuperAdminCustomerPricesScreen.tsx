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
import superAdminApi, { CustomerPrice } from '../../services/superAdminApi';
import CategoryItemPicker from './CategoryItemPicker';
import PriceCategoryGroups, { PriceItemRow } from './PriceCategoryGroups';

/**
 * Customer Price List — the GLOBAL price list.
 *
 * One price per item, and every customer pays it. There is deliberately
 * no per-customer anything on this screen, because there is no such
 * thing in the data.
 *
 * Nothing here calculates a price. Amounts are rendered as the backend
 * returned them, and an edit posts a figure the backend validates and
 * stores; this screen is not a source of truth for any number.
 *
 * CATEGORY -> SUB-CATEGORY -> ITEMS, and in that order.
 *
 * The list is not shown until a main category is chosen, and — for a category
 * that has sub-categories — until a sub-category is chosen under it. Showing
 * a hundred items at once is what made finding one hard; narrowing to a
 * sub-category first is how the catalogue is actually navigated.
 *
 * The sub-category choices DEPEND on the category above them: only that
 * category's own children are offered, so an impossible pair cannot be
 * selected. Items are then those of that category AND that sub-category.
 *
 * The grouping is drawn by PriceCategoryGroups and the ordering comes from the
 * backend, so the screen shows the catalogue's own order rather than a second
 * sort that could disagree with it.
 *
 * ADDING AN ENTRY walks the same three levels, and can create the item on the
 * way if it does not exist yet — see CategoryItemPicker.
 *
 * A ZERO PRICE HIDES THE ITEM FROM CUSTOMERS — the backend excludes it from
 * every customer endpoint. The status column says so, because "Active with a
 * price of 0" would otherwise look like a working row.
 */

const money = (value: number | null) =>
  value === null || value === undefined ? '—' : `₹${Number(value).toFixed(2)}`;

/** The top-level category of a row. A flat category IS the top level. */
const topCategoryId = (row: CustomerPrice) => row.parent_category_id || row.category_id;
const topCategoryName = (row: CustomerPrice) => row.parent_category_name || row.category_name;
/** The sub-category, when there is one. A flat category has none. */
const subCategoryName = (row: CustomerPrice) =>
  row.parent_category_name ? row.category_name : null;
/** The sub-category's id, or null for an item filed on the main category. */
const subCategoryId = (row: CustomerPrice) =>
  row.parent_category_id ? row.category_id : null;

export default function SuperAdminCustomerPricesScreen({ navigation }: any) {
  const [rows, setRows] = useState<CustomerPrice[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  /** null = closed, 'new' = add form, otherwise the row being edited. */
  const [editing, setEditing] = useState<CustomerPrice | 'new' | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await superAdminApi.getCustomerPrices());
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load the price list');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /** Narrows to one top-level category. '' = all. */
  const [categoryFilter, setCategoryFilter] = useState('');
  /** Narrows to one sub-category of that category. '' = all. */
  const [subcategoryFilter, setSubcategoryFilter] = useState('');
  /** ''=all, 'active', 'inactive'. */
  const [statusFilter, setStatusFilter] = useState('');

  /** The top-level categories present in the list, for the chips. */
  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      const id = topCategoryId(row);
      const name = topCategoryName(row);
      if (id && name && !seen.has(id)) seen.set(id, name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [rows]);

  /**
   * The sub-categories of the chosen category, and only those — the second
   * filter is dependent on the first, exactly as the add form's pickers are.
   */
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

  // Filtering is local: the list is one page of catalogue items, so a
  // round trip per keystroke would be slower than it is worth.
  const shown = useMemo(() => {
    // Nothing until Category -> Sub-category has been answered.
    if (!readyToList) return [];
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (categoryFilter && topCategoryId(row) !== categoryFilter) return false;
      if (subcategoryFilter && row.category_id !== subcategoryFilter) return false;
      if (statusFilter === 'active' && !row.is_active) return false;
      if (statusFilter === 'inactive' && row.is_active) return false;
      if (!needle) return true;
      return (
        row.item_name.toLowerCase().includes(needle) ||
        (row.category_name || '').toLowerCase().includes(needle) ||
        (row.parent_category_name || '').toLowerCase().includes(needle)
      );
    });
  }, [rows, search, categoryFilter, subcategoryFilter, statusFilter, readyToList]);

  const toggleActive = async (row: CustomerPrice) => {
    try {
      await superAdminApi.updateCustomerPrice(row.id, { is_active: !row.is_active });
      load();
    } catch (e: any) {
      Alert.alert('Could not update', e?.response?.data?.message || e.message);
    }
  };

  /**
   * Delete asks first, and the default action is the safe one: disable.
   * Historical invoices reference these items, so removing the row
   * outright is offered only as the destructive second choice.
   */
  const confirmDelete = (row: CustomerPrice) => {
    Alert.alert(
      'Delete this price?',
      `${row.item_name} — ${money(row.customer_price)}\n\n` +
        'Past orders keep the price they were placed at either way. ' +
        'Disabling keeps the row so it can be switched back on.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disable',
          onPress: async () => {
            try {
              await superAdminApi.deleteCustomerPrice(row.id);
              load();
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
              await superAdminApi.deleteCustomerPrice(row.id, true);
              load();
            } catch (e: any) {
              // The backend refuses a hard delete once an order names the
              // item; its message says so, and is shown as-is.
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
        <Text style={sa.headerTitle}>Customer Price List</Text>
      </View>

      <View style={{ paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm }}>
        {/* The primary action, stated in words rather than as a "+" in the
            header where it is easy to miss. */}
        <TouchableOpacity
          style={sa.addEntryBtn}
          onPress={() => setEditing('new')}
          accessibilityRole="button"
          accessibilityLabel="Add a new customer price entry"
        >
          <Ionicons name="add" size={20} color={COLORS.Surface} />
          <Text style={sa.addEntryText}>Add New Entry</Text>
        </TouchableOpacity>

        <TextInput
          style={[sa.input, { marginTop: SPACING.sm }]}
          placeholder="Search item, category or subcategory"
          placeholderTextColor={COLORS.TextSecondary}
          value={search}
          onChangeText={setSearch}
        />
        <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
          These prices apply to every customer.
        </Text>
      </View>

      {/* STEP 1 — Category. Required: there is no "all", because showing
          every item at once is the thing this replaces. */}
      <Text style={[sa.label, { paddingHorizontal: SPACING.md }]}>CATEGORY</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={sa.filterBar}
      >
        {categoryOptions.map((c) => (
          <FilterChip
            key={c.id}
            label={c.name}
            on={categoryFilter === c.id}
            onPress={() => chooseCategory(categoryFilter === c.id ? '' : c.id)}
          />
        ))}
      </ScrollView>

      {/* STEP 2 — Sub-category. DEPENDENT on the category above: it appears
          only once one is chosen, and lists only that category's children, so
          a pair that does not exist cannot be selected. */}
      {categoryFilter && subcategoryOptions.length > 0 ? (
        <>
          <Text style={[sa.label, { paddingHorizontal: SPACING.md }]}>SUB CATEGORY</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={sa.filterBar}
          >
            {subcategoryOptions.map((c) => (
              <FilterChip
                key={c.id}
                label={c.name}
                on={subcategoryFilter === c.id}
                onPress={() => setSubcategoryFilter(subcategoryFilter === c.id ? '' : c.id)}
              />
            ))}
          </ScrollView>
        </>
      ) : null}

      {/* Status filter. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={sa.filterBar}
      >
        <FilterChip
          label="All statuses"
          on={statusFilter === ''}
          onPress={() => setStatusFilter('')}
        />
        <FilterChip
          label="Active"
          on={statusFilter === 'active'}
          onPress={() => setStatusFilter(statusFilter === 'active' ? '' : 'active')}
        />
        <FilterChip
          label="Disabled"
          on={statusFilter === 'inactive'}
          onPress={() => setStatusFilter(statusFilter === 'inactive' ? '' : 'inactive')}
        />
      </ScrollView>

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
              onRefresh={() => { setRefreshing(true); load(); }}
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
            /* The prompt, not an error: nothing has gone wrong, a choice has
               simply not been made yet. It names the step that is missing. */
            <Text style={sa.empty}>
              {rows.length === 0
                ? 'No customer prices yet. Use Add New Entry to add the first one.'
                : categoryFilter === ''
                  ? 'Choose a category to see its items.'
                  : 'Choose a sub-category to see its items.'}
            </Text>
          ) : shown.length === 0 ? (
            <Text style={sa.empty}>No item matches those filters.</Text>
          ) : (
            /* Main Category -> Sub-category -> Items. Every group opens while
               a search or filter is narrowing the list, so a match is never
               left behind a collapsed header. */
            <PriceCategoryGroups
              rows={shown}
              keyOf={(row) => row.id}
              topIdOf={topCategoryId}
              topNameOf={topCategoryName}
              subIdOf={subCategoryId}
              subNameOf={(row) => subCategoryName(row)}
              expandAll={
                search.trim() !== '' ||
                categoryFilter !== '' ||
                subcategoryFilter !== '' ||
                statusFilter !== ''
              }
              renderItem={(row) => (
                <PriceItemRow
                  title={row.item_name}
                  subtitle={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: 2 }}>
                      {/* The word is always present: status is never colour alone. */}
                      <StatusPill active={row.is_active} />
                      {/* A zero price is not a price: the backend hides the
                          item from customers, so the row says so rather than
                          showing a healthy-looking "Active". */}
                      {row.is_active && Number(row.customer_price) <= 0 ? (
                        <Text style={[sa.tdMuted, { color: COLORS.Warning, fontSize: 10 }]}>
                          hidden (₹0)
                        </Text>
                      ) : null}
                      {!row.item_is_active ? (
                        <Text style={[sa.tdMuted, { color: COLORS.Warning, fontSize: 10 }]}>
                          item disabled
                        </Text>
                      ) : null}
                    </View>
                  }
                  right={
                    <>
                      <Text style={sa.tdPrice}>{money(row.customer_price)}</Text>
                      {row.original_price !== null && (
                        <Text
                          style={[
                            sa.tdMuted,
                            { textAlign: 'right', textDecorationLine: 'line-through' },
                          ]}
                        >
                          {money(row.original_price)}
                        </Text>
                      )}
                    </>
                  }
                  actions={
                    <>
                      <ActionButton
                        icon="create-outline"
                        label="Edit"
                        tone="primary"
                        onPress={() => setEditing(row)}
                        accessibilityLabel={`Edit ${row.item_name}`}
                      />
                      <ActionButton
                        icon={row.is_active ? 'close-circle-outline' : 'checkmark-circle-outline'}
                        label={row.is_active ? 'Disable' : 'Enable'}
                        onPress={() => toggleActive(row)}
                        accessibilityLabel={
                          row.is_active ? `Disable ${row.item_name}` : `Enable ${row.item_name}`
                        }
                      />
                      <ActionButton
                        icon="trash-outline"
                        label="Delete"
                        tone="danger"
                        onPress={() => confirmDelete(row)}
                        accessibilityLabel={`Delete ${row.item_name}`}
                      />
                    </>
                  }
                />
              )}
            />
          )}

          <TouchableOpacity
            style={[sa.addEntryBtn, { marginTop: SPACING.lg }]}
            onPress={() => setEditing('new')}
          >
            <Ionicons name="add" size={20} color={COLORS.Surface} />
            <Text style={sa.addEntryText}>Add New Entry</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      <CustomerPriceModal
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    </SafeAreaView>
  );
}

function FilterChip({
  label, on, onPress,
}: { label: string; on: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[sa.filterChip, on && sa.filterChipOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[sa.filterChipText, on && sa.filterChipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * A row action that says what it does.
 *
 * Shared by both price lists through `sa.actionBtn`, so Edit on one screen is
 * the same size and shape as Edit on the other.
 */
export function ActionButton({
  icon, label, onPress, tone, accessibilityLabel,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'danger';
  accessibilityLabel?: string;
}) {
  const color =
    tone === 'danger' ? COLORS.Error : tone === 'primary' ? COLORS.Primary : COLORS.TextSecondary;
  return (
    <TouchableOpacity
      style={[
        sa.actionBtn,
        tone === 'primary' && sa.actionBtnPrimary,
        tone === 'danger' && sa.actionBtnDanger,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
    >
      <Ionicons name={icon} size={15} color={color} />
      <Text style={[sa.actionBtnText, { color }]}>{label}</Text>
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
 * ADD / EDIT
 * =================================================================== */

interface ModalProps {
  target: CustomerPrice | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * One sheet for both jobs.
 *
 * ADDING walks Category -> Subcategory -> Item and then asks for the price.
 * There is no separate "new item" mode any more: the picker itself offers
 * "+ Create New Item" when the item does not exist yet, which creates the
 * catalogue row and selects it, so one flow covers both cases and the item is
 * created through the one endpoint both price lists use.
 *
 * EDITING only changes the price and the status — the item itself belongs to
 * the catalogue, not to the price list.
 */
function CustomerPriceModal({ target, onClose, onSaved }: ModalProps) {
  const row = target && target !== 'new' ? target : null;

  const [itemId, setItemId] = useState<string>('');
  const [itemName, setItemName] = useState<string>('');
  const [price, setPrice] = useState('');
  const [original, setOriginal] = useState('');
  const [active, setActive] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reset every time the sheet opens, so the previous row's values can
  // never leak into the next edit.
  React.useEffect(() => {
    if (!target) return;
    setError('');
    if (row) {
      setItemId(row.item_id);
      setItemName(row.item_name);
      setPrice(String(row.customer_price));
      setOriginal(row.original_price === null ? '' : String(row.original_price));
      setActive(row.is_active);
    } else {
      setItemId('');
      setItemName('');
      setPrice('');
      setOriginal('');
      setActive(true);
    }
  }, [target]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (row) {
        await superAdminApi.updateCustomerPrice(row.id, {
          customer_price: price,
          original_price: original === '' ? null : original,
          is_active: active,
        });
      } else {
        await superAdminApi.createCustomerPrice({
          item_id: itemId,
          customer_price: price,
          original_price: original === '' ? null : original,
          is_active: active,
        });
      }
      onSaved();
    } catch (e: any) {
      // The backend owns validation; its message is shown verbatim so the
      // two can never disagree about what is wrong.
      setError(e?.response?.data?.message || e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const canSave = price.trim() !== '' && (row !== null || itemId !== '');

  return (
    <Modal visible={target !== null} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>
              {row ? 'Edit price' : 'Add New Entry'}
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
                  {topCategoryName(row) || 'No category'}
                  {subCategoryName(row) ? ` · ${subCategoryName(row)}` : ''}
                </Text>
              </View>
            ) : (
              <>
                {/* Category -> Subcategory -> Item, dependent. Only items with
                    no customer price yet are offered, so a selection here can
                    never collide with an existing row — and "+ Create New
                    Item" covers the case where the item does not exist. */}
                <CategoryItemPicker
                  unpricedOnly
                  selectedItemId={itemId}
                  onSelectItem={(id, item) => {
                    setItemId(id);
                    setItemName(item?.name || '');
                  }}
                />
                {itemName ? (
                  <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
                    Pricing: {itemName}
                  </Text>
                ) : null}
              </>
            )}

            <Text style={sa.label}>
              CUSTOMER PRICE (₹) <Text style={sa.required}>*</Text>
            </Text>
            <TextInput
              style={sa.input}
              placeholder="0.00"
              placeholderTextColor={COLORS.TextSecondary}
              keyboardType="decimal-pad"
              value={price}
              onChangeText={setPrice}
            />

            <Text style={sa.label}>ORIGINAL PRICE (₹)</Text>
            <TextInput
              style={sa.input}
              placeholder="Leave blank if there is no struck-through price"
              placeholderTextColor={COLORS.TextSecondary}
              keyboardType="decimal-pad"
              value={original}
              onChangeText={setOriginal}
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
                {active ? 'Active — customers see this price' : 'Disabled — hidden from customers'}
              </Text>
            </View>

            <TouchableOpacity
              style={[sa.button, (!canSave || busy) && sa.buttonDisabled]}
              onPress={save}
              disabled={!canSave || busy}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.Surface} />
              ) : (
                <Text style={sa.buttonText}>{row ? 'Save changes' : 'Add Entry'}</Text>
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
