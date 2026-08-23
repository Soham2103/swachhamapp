import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';
import { sa } from './styles';
import superAdminApi, { ItemCategory, PriceableItem } from '../../services/superAdminApi';

/**
 * The dependent Category -> Sub-category -> Item selection, used by BOTH
 * price lists.
 *
 * ONE COMPONENT, because the Customer Price List and the Business Price List
 * ask exactly the same question and two copies would drift.
 *
 * DEPENDENT, NOT MERELY FILTERED. Choosing a Category narrows the
 * Sub-category options to its children; choosing a Sub-category narrows the
 * Items to that sub-category alone. Changing a level upstream clears the
 * levels below it, so the three can never describe a combination that does
 * not exist, and no unrelated item is ever offered.
 *
 * The Item dropdown stays LOCKED until the level above it is settled: a
 * category with sub-categories needs one chosen, because its items live in
 * the sub-categories and not beside them. A flat category -- one with no
 * children -- goes straight from Category to Item, since there is no middle
 * level to pick.
 *
 * The tree is the app's EXISTING `service_categories`: a row with no parent
 * is a Category, a row with a parent is a Sub-category, and items hang off
 * the sub-category by id. Nothing new was invented to model it.
 *
 * "+ CREATE NEW ITEM" is offered once the category level is settled. It
 * creates a real catalogue item under the chosen Category/Sub-category
 * through the server, then selects it here — so the item exists once, in the
 * one catalogue both price lists read, and is available immediately.
 */

interface Props {
  /** Restricts the item list, e.g. to items with no customer price yet. */
  unpricedOnly?: boolean;
  /** Item ids to leave out — those already priced in the current context. */
  excludeItemIds?: string[];
  selectedItemId: string;
  onSelectItem: (itemId: string, item: PriceableItem | null) => void;
  /**
   * Offers "+ Create New Item". On by default: both price lists need it, and
   * a caller that only reads the catalogue can turn it off.
   */
  allowCreate?: boolean;
}

export default function CategoryItemPicker({
  unpricedOnly,
  excludeItemIds = [],
  selectedItemId,
  onSelectItem,
  allowCreate = true,
}: Props) {
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [items, setItems] = useState<PriceableItem[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<'category' | 'subcategory' | 'item' | null>(null);
  const [creating, setCreating] = useState(false);

  const loadCategories = useCallback(() => {
    superAdminApi.getPriceCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  const tops = useMemo(() => categories.filter((c) => c.is_top_level), [categories]);
  const subs = useMemo(
    () => categories.filter((c) => c.parent_id === categoryId),
    [categories, categoryId]
  );

  /**
   * A category with children hands its items to those children, so the Item
   * level is not reachable until one is chosen. A flat category IS the level
   * items hang off.
   */
  const hasSubs = subs.length > 0;
  const categorySettled = Boolean(categoryId) && (!hasSubs || Boolean(subcategoryId));

  /** The category row a new item would be filed under. */
  const targetCategoryId = subcategoryId || categoryId;

  // Items are fetched for the narrowest level chosen, so the server does the
  // filtering and the client never holds the whole catalogue.
  const loadItems = useCallback(() => {
    if (!categorySettled) {
      setItems([]);
      return Promise.resolve([] as PriceableItem[]);
    }
    setLoading(true);
    return superAdminApi
      .getPriceableItems({
        categoryId: subcategoryId ? undefined : categoryId,
        subcategoryId: subcategoryId || undefined,
        unpriced: unpricedOnly,
      })
      .then((list) => {
        setItems(list);
        return list;
      })
      .catch(() => {
        setItems([]);
        return [] as PriceableItem[];
      })
      .finally(() => setLoading(false));
  }, [categoryId, subcategoryId, categorySettled, unpricedOnly]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const excluded = useMemo(() => new Set(excludeItemIds), [excludeItemIds]);
  const shownItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items
      .filter((i) => !excluded.has(i.id))
      .filter((i) => (needle ? i.name.toLowerCase().includes(needle) : true))
      .slice(0, 60);
  }, [items, search, excluded]);

  const selected = items.find((i) => i.id === selectedItemId) || null;
  const categoryName = tops.find((c) => c.id === categoryId)?.name || '';
  const subcategoryName = subs.find((c) => c.id === subcategoryId)?.name || '';

  /** Changing a level clears everything below it. */
  const chooseCategory = (id: string) => {
    setCategoryId(id);
    setSubcategoryId('');
    onSelectItem('', null);
    setOpen(null);
  };
  const chooseSubcategory = (id: string) => {
    setSubcategoryId(id);
    onSelectItem('', null);
    setOpen(null);
  };

  /**
   * A newly created item joins the list and is selected, so the operator can
   * type its price straight away rather than reopening the dropdown to find
   * what they just made.
   */
  const onCreated = async (item: PriceableItem) => {
    setCreating(false);
    const refreshed = await loadItems();
    // Falls back to the returned row if the refreshed list has not landed:
    // either way the selection is the item that was just created.
    const match = refreshed.find((i) => i.id === item.id) || item;
    onSelectItem(match.id, match);
    // The counts on the category dropdown are now one out of date.
    loadCategories();
  };

  const field = (
    label: string,
    value: string,
    placeholder: string,
    which: 'category' | 'subcategory' | 'item',
    enabled: boolean
  ) => (
    <>
      <Text style={sa.label}>
        {label} <Text style={sa.required}>*</Text>
      </Text>
      <TouchableOpacity
        style={[sa.selectRow, value ? sa.selectRowFilled : null, !enabled && sa.selectDisabled]}
        onPress={() => enabled && setOpen(which)}
        disabled={!enabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value || placeholder}`}
      >
        <Text style={[sa.selectValue, !value && sa.selectPlaceholder]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={COLORS.TextSecondary} />
      </TouchableOpacity>
    </>
  );

  return (
    <View>
      {field('CATEGORY', categoryName, 'Select Category', 'category', true)}

      {/* Offered only when the chosen category actually has children. A flat
          category's items hang off it directly, so there is no middle level
          to choose and inventing an empty one would be a dead end. */}
      {categoryId && hasSubs
        ? field('SUBCATEGORY', subcategoryName, 'Select Subcategory', 'subcategory', true)
        : null}

      {field(
        'ITEM',
        selected?.name || '',
        !categoryId
          ? 'Choose a category first'
          : hasSubs && !subcategoryId
            ? 'Choose a subcategory first'
            : 'Select Item',
        'item',
        categorySettled
      )}

      {/* "Can't find your item?" — only once the item would have somewhere to
          go. Creating before the category is settled would have to guess. */}
      {allowCreate && categorySettled ? (
        <TouchableOpacity
          style={sa.linkRow}
          onPress={() => setCreating(true)}
          accessibilityRole="button"
          accessibilityLabel="Create a new item in this subcategory"
        >
          <Ionicons name="add-circle-outline" size={18} color={COLORS.Primary} />
          <Text style={sa.linkText}>Can't find your item? + Create New Item</Text>
        </TouchableOpacity>
      ) : null}

      <PickerSheet
        visible={open !== null}
        title={
          open === 'category' ? 'Select Category'
            : open === 'subcategory' ? 'Select Subcategory' : 'Select Item'
        }
        onClose={() => setOpen(null)}
        searchable={open === 'item'}
        search={search}
        onSearch={setSearch}
        loading={open === 'item' && loading}
      >
        {open === 'category' &&
          tops.map((c) => (
            <Option
              key={c.id}
              label={c.name}
              meta={`${c.item_count} item${c.item_count === 1 ? '' : 's'}`}
              selected={categoryId === c.id}
              onPress={() => chooseCategory(c.id)}
            />
          ))}

        {/* No "All sub-categories" choice: the Item list must belong to ONE
            sub-category, which is what keeps unrelated items out of it. */}
        {open === 'subcategory' &&
          subs.map((c) => (
            <Option
              key={c.id}
              label={c.name}
              meta={`${c.item_count} item${c.item_count === 1 ? '' : 's'}`}
              selected={subcategoryId === c.id}
              onPress={() => chooseSubcategory(c.id)}
            />
          ))}

        {open === 'item' && (
          shownItems.length === 0 && !loading ? (
            <>
              <Text style={sa.empty}>
                {items.length === 0
                  ? 'No items here yet.'
                  : 'Every item here is already priced.'}
              </Text>
              {allowCreate ? (
                <TouchableOpacity
                  style={sa.buttonGhost}
                  onPress={() => { setOpen(null); setCreating(true); }}
                >
                  <Text style={sa.buttonGhostText}>+ Create New Item</Text>
                </TouchableOpacity>
              ) : null}
            </>
          ) : (
            <>
              {shownItems.map((i) => (
                <Option
                  key={i.id}
                  label={i.name}
                  meta={i.category_name || undefined}
                  selected={selectedItemId === i.id}
                  onPress={() => {
                    onSelectItem(i.id, i);
                    setOpen(null);
                  }}
                />
              ))}
              {allowCreate ? (
                <TouchableOpacity
                  style={sa.buttonGhost}
                  onPress={() => { setOpen(null); setCreating(true); }}
                >
                  <Text style={sa.buttonGhostText}>+ Create New Item</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )
        )}
      </PickerSheet>

      <CreateItemSheet
        visible={creating}
        categoryName={categoryName}
        subcategoryName={subcategoryName}
        categoryId={categoryId}
        subcategoryId={subcategoryId}
        targetCategoryId={targetCategoryId}
        onClose={() => setCreating(false)}
        onCreated={onCreated}
      />
    </View>
  );
}

/* ===================================================================
 * CREATE NEW ITEM
 * =================================================================== */

/**
 * Creates one catalogue item under the Category/Sub-category already chosen.
 *
 * The two category fields are SHOWN, NOT ASKED AGAIN: the item belongs where
 * the picker was pointing, and re-asking would let the two disagree. Only the
 * name is entered.
 *
 * The duplicate rule lives in the backend — "Item already exists in this
 * subcategory." — and its message is rendered verbatim, so the form can never
 * claim something different from what the server decided.
 */
function CreateItemSheet({
  visible, categoryName, subcategoryName, categoryId, subcategoryId, targetCategoryId,
  onClose, onCreated,
}: {
  visible: boolean;
  categoryName: string;
  subcategoryName: string;
  categoryId: string;
  subcategoryId: string;
  targetCategoryId: string;
  onClose: () => void;
  onCreated: (item: PriceableItem) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setName('');
    setError('');
  }, [visible]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const item = await superAdminApi.createItem({
        item_name: name.trim(),
        // Both levels are sent so the server can check the pair really
        // exists, rather than trusting one id on its own.
        category_id: categoryId || undefined,
        subcategory_id: subcategoryId || undefined,
      });
      onCreated(item);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not create the item');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>Create New Item</Text>
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

            <Text style={sa.label}>CATEGORY</Text>
            <View style={sa.readOnlyBox}>
              <Text style={sa.readOnlyText}>{categoryName || '—'}</Text>
              <Ionicons name="lock-closed-outline" size={14} color={COLORS.TextSecondary} />
            </View>

            {subcategoryName ? (
              <>
                <Text style={sa.label}>SUBCATEGORY</Text>
                <View style={sa.readOnlyBox}>
                  <Text style={sa.readOnlyText}>{subcategoryName}</Text>
                  <Ionicons name="lock-closed-outline" size={14} color={COLORS.TextSecondary} />
                </View>
              </>
            ) : null}

            <Text style={sa.label}>
              ITEM NAME <Text style={sa.required}>*</Text>
            </Text>
            <TextInput
              style={sa.input}
              placeholder="e.g. Designer Shirt"
              placeholderTextColor={COLORS.TextSecondary}
              value={name}
              onChangeText={setName}
              autoFocus
            />

            <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
              The item is added to the catalogue under this category and becomes available
              in both the Customer and Business price lists.
            </Text>

            <TouchableOpacity
              style={[sa.button, (!name.trim() || !targetCategoryId || busy) && sa.buttonDisabled]}
              onPress={create}
              disabled={!name.trim() || !targetCategoryId || busy}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.Surface} />
              ) : (
                <Text style={sa.buttonText}>Create Item</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={sa.buttonGhost} onPress={onClose}>
              <Text style={sa.buttonGhostText}>Cancel</Text>
            </TouchableOpacity>

            <View style={{ height: SPACING.xxl }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Option({
  label, meta, selected, onPress,
}: { label: string; meta?: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[sa.choice, selected && sa.choiceActive]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={selected ? COLORS.Primary : COLORS.TextSecondary}
      />
      <View style={{ flex: 1 }}>
        <Text style={sa.choiceText} numberOfLines={1}>{label}</Text>
        {meta ? <Text style={sa.tdMuted}>{meta}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

/** The bottom sheet the three pickers share. */
function PickerSheet({
  visible, title, onClose, children, searchable, search, onSearch, loading,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  searchable?: boolean;
  search?: string;
  onSearch?: (v: string) => void;
  loading?: boolean;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sa.modalBackdrop}>
        <View style={sa.modalSheet}>
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>{title}</Text>
            <TouchableOpacity style={sa.iconBtn} onPress={onClose} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={COLORS.TextPrimary} />
            </TouchableOpacity>
          </View>

          {searchable ? (
            <View style={{ paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm }}>
              <TextInput
                style={sa.input}
                placeholder="Search items"
                placeholderTextColor={COLORS.TextSecondary}
                value={search}
                onChangeText={onSearch}
              />
            </View>
          ) : null}

          <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
            {loading ? (
              <ActivityIndicator color={COLORS.Primary} style={{ marginTop: SPACING.lg }} />
            ) : (
              children
            )}
            <View style={{ height: SPACING.xl }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
