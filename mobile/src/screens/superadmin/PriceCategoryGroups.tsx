import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { sa } from './styles';
import { buildGroups } from './priceGrouping';

export { NO_SUBCATEGORY_LABEL, buildGroups } from './priceGrouping';

/**
 * Main Category -> Sub Category -> Items, for both price lists.
 *
 * WHY A COMPONENT AND NOT TWO TABLES. The Customer Price List and the
 * Business Price List price the same catalogue and are organised by the same
 * tree, so the grouping is one behaviour with two row renderers rather than
 * two behaviours. Each screen still owns its own row -- its columns, its
 * buttons, its actions -- and passes it in through `renderItem`; nothing about
 * what a row can DO lives here.
 *
 * THE GROUPING ITSELF lives in `priceGrouping.ts`, which is pure and has no
 * React Native imports -- so it can be run and checked against the real
 * catalogue without a device. This file is the drawing.
 *
 * COLLAPSING is per main category. When a search or filter is narrowing the
 * list every group opens, because hiding the matches behind a closed header is
 * the opposite of what a filter is for.
 */

interface Props<T> {
  rows: T[];
  /** Stable react key for one row. */
  keyOf: (row: T) => string;
  /** The main category: a row's parent category, or its own when top-level. */
  topIdOf: (row: T) => string | null;
  topNameOf: (row: T) => string | null;
  /** The sub-category, or null for an item filed straight on the main one. */
  subIdOf: (row: T) => string | null;
  subNameOf: (row: T) => string | null;
  /** The screen's own row. Everything it can do belongs to the screen. */
  renderItem: (row: T) => React.ReactNode;
  /**
   * Open every group. Passed while a search or filter is active, so matches
   * are never hidden behind a collapsed header.
   */
  expandAll?: boolean;
}

export default function PriceCategoryGroups<T>({
  rows,
  keyOf,
  topIdOf,
  topNameOf,
  subIdOf,
  subNameOf,
  renderItem,
  expandAll = false,
}: Props<T>) {
  const groups = useMemo(
    () => buildGroups(rows, { topIdOf, topNameOf, subIdOf, subNameOf }),
    // The accessors are stable for a given screen; the rows are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows]
  );

  /**
   * Which categories the user has collapsed.
   *
   * Tracking what is CLOSED rather than what is open means a category that
   * appears after an item is added starts open, like every other one, instead
   * of arriving shut because it was not in the set.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  return (
    <View>
      {groups.map((group) => {
        const open = expandAll || !collapsed[group.key];
        return (
          <View key={group.key} style={styles.categoryCard}>
            <TouchableOpacity
              style={styles.categoryHeader}
              onPress={() => toggle(group.key)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`${group.name}, ${group.count} items`}
              activeOpacity={0.7}
            >
              <Text style={styles.categoryTitle} numberOfLines={2}>
                {group.name.toUpperCase()}
              </Text>
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{group.count}</Text>
              </View>
              <Ionicons
                name={open ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={COLORS.Surface}
              />
            </TouchableOpacity>

            {open ? (
              <View style={styles.categoryBody}>
                {group.subgroups.map((sub) => (
                  <View key={sub.key} style={styles.subGroup}>
                    <View style={styles.subHeader}>
                      <Text style={styles.subTitle} numberOfLines={2}>
                        {sub.name}
                      </Text>
                      <Text style={styles.subCount}>
                        {sub.items.length} item{sub.items.length === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={styles.subRule} />
                    {sub.items.map((row) => (
                      <View key={keyOf(row)}>{renderItem(row)}</View>
                    ))}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * One item row's shell: the name on the left, whatever the screen puts on the
 * right, and the screen's action buttons underneath.
 *
 * Laid out in rows that WRAP rather than as fixed-width columns, so the same
 * row reads on a narrow phone without the page scrolling sideways — which is
 * what the flat table needed and what made it hard to follow.
 */
export function PriceItemRow({
  title,
  subtitle,
  right,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <View style={styles.itemRow}>
      <View style={styles.itemTop}>
        <View style={sa.flex}>
          <Text style={styles.itemName} numberOfLines={2}>
            {title}
          </Text>
          {subtitle}
        </View>
        {right ? <View style={styles.itemRight}>{right}</View> : null}
      </View>
      {actions ? <View style={styles.itemActions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  categoryCard: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    marginBottom: SPACING.md,
    overflow: 'hidden',
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  categoryTitle: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800',
    letterSpacing: 0.6,
    color: COLORS.Surface,
  },
  countPill: {
    minWidth: 26,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.full,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
  },
  countPillText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.Surface,
  },
  categoryBody: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  subGroup: { marginTop: SPACING.md },
  subHeader: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING.xs },
  subTitle: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
  },
  subCount: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    color: COLORS.TextSecondary,
  },
  subRule: {
    height: 1,
    backgroundColor: COLORS.Border,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  itemRow: {
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Background,
  },
  itemTop: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  itemName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
    fontWeight: '600',
  },
  itemRight: { alignItems: 'flex-end' },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
});
