/**
 * Main Category -> Sub Category -> Items, as data.
 *
 * Pure on purpose, and in its own file with no React Native imports, so the
 * grouping the Price Adjustment screens draw can be run and checked on its
 * own — which is what `scripts/smoke_price_grouping.ts` does against the real
 * catalogue. A grouping that only exists inside a component is a grouping
 * nobody can test without a device.
 *
 * IT DOES NOT SORT. The rows arrive from the backend already ordered main
 * category -> sub-category -> item (PRICE_LIST_ORDER in priceList.service), so
 * this walks them once in the order given and starts a new group when the key
 * changes. The screen therefore shows the catalogue's own order, and an item
 * added to a sub-category appears exactly where the backend files it.
 *
 * A row whose category has no parent is an item filed straight on a main
 * category. It is not dropped: it goes into an explicitly labelled group, so
 * it stays visible and editable rather than disappearing from the screen that
 * exists to fix it.
 */

/** The heading an item with no sub-category is collected under. */
export const NO_SUBCATEGORY_LABEL = 'Not in a sub-category';

export interface SubGroup<T> {
  key: string;
  name: string;
  items: T[];
}

export interface MainGroup<T> {
  key: string;
  name: string;
  count: number;
  subgroups: SubGroup<T>[];
}

export interface GroupAccessors<T> {
  /** The main category: the row's parent category, or its own when top-level. */
  topIdOf: (row: T) => string | null;
  topNameOf: (row: T) => string | null;
  /** The sub-category, or null for an item filed straight on the main one. */
  subIdOf: (row: T) => string | null;
  subNameOf: (row: T) => string | null;
}

export function buildGroups<T>(rows: T[], a: GroupAccessors<T>): MainGroup<T>[] {
  const groups: MainGroup<T>[] = [];

  for (const row of rows) {
    const topKey = String(a.topIdOf(row) ?? 'uncategorised');
    const topName = a.topNameOf(row) || 'Uncategorised';
    // One bucket per main category for the sub-category-less rows, so the
    // heading appears once rather than once per item.
    const rawSubId = a.subIdOf(row);
    const subKey = rawSubId ? String(rawSubId) : `${topKey}:none`;
    const subName = rawSubId ? a.subNameOf(row) || 'Sub-category' : NO_SUBCATEGORY_LABEL;

    let main = groups[groups.length - 1];
    if (!main || main.key !== topKey) {
      // Re-entering a category the list already passed would mean the rows
      // were not ordered; rejoin it rather than showing it twice.
      const existing = groups.find((g) => g.key === topKey);
      if (existing) {
        main = existing;
      } else {
        main = { key: topKey, name: topName, count: 0, subgroups: [] };
        groups.push(main);
      }
    }

    let sub = main.subgroups[main.subgroups.length - 1];
    if (!sub || sub.key !== subKey) {
      const existing = main.subgroups.find((g) => g.key === subKey);
      if (existing) {
        sub = existing;
      } else {
        sub = { key: subKey, name: subName, items: [] };
        main.subgroups.push(sub);
      }
    }

    sub.items.push(row);
    main.count += 1;
  }

  return groups;
}
