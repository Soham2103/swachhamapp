import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, TYPOGRAPHY, SPACING, BORDER_RADIUS } from '../../constants/theme';
import serviceApi from '../../services/serviceApi';

interface Item {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  unit: string;
  weight_kg: number | null;
}

/**
 * The items inside one laundry category.
 *
 * Paginated, because the catalogue endpoint is: the business list
 * already runs to 34 pages and a customer list will grow the same way,
 * so this pages rather than assuming one request holds everything.
 */
export default function ServiceCategoryScreen({ navigation, route }: any) {
  const { categoryId, name } = route.params || {};

  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const fetchPage = useCallback(
    async (nextPage: number, replace: boolean) => {
      setError('');
      try {
        const res: any = await serviceApi.getServices({
          category: categoryId,
          page: nextPage,
          limit: 20,
        });
        const rows = (res.data as Item[]) || [];
        setItems((prev) => (replace ? rows : [...prev, ...rows]));
        setTotal(res.pagination?.total ?? rows.length);
        setPage(nextPage);
      } catch (e: any) {
        setError(e?.response?.data?.message || e.message || 'Could not load this category');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [categoryId]
  );

  useFocusEffect(
    useCallback(() => {
      fetchPage(1, true);
    }, [fetchPage])
  );

  const loadMore = () => {
    if (loadingMore || items.length >= total) return;
    setLoadingMore(true);
    fetchPage(page + 1, false);
  };

  const priceLabel = (i: Item) =>
    i.price == null ? 'Price on request' : `₹${i.price} / ${i.unit}`;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{name || 'Services'}</Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.id)}
          contentContainerStyle={styles.list}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => fetchPage(1, true)} />
          }
          ListHeaderComponent={
            !!error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>Nothing in this category yet.</Text>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={COLORS.Primary} /> : null
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.flex}>
                <Text style={styles.name}>{item.name}</Text>
                {!!item.description && (
                  <Text style={styles.desc} numberOfLines={2}>{item.description}</Text>
                )}
                {item.weight_kg != null && (
                  <Text style={styles.meta}>approx {item.weight_kg} kg</Text>
                )}
              </View>
              <Text style={styles.price}>{priceLabel(item)}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  back: { padding: SPACING.xs },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold', color: COLORS.TextPrimary, flex: 1,
  },
  list: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  flex: { flex: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md, marginBottom: SPACING.xs,
    borderWidth: 1, borderColor: COLORS.Border,
  },
  name: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.TextPrimary,
  },
  desc: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, color: COLORS.TextSecondary,
  },
  meta: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 10, color: COLORS.TextSecondary,
  },
  price: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600', color: COLORS.Primary, marginLeft: SPACING.sm,
  },
  empty: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary, textAlign: 'center', marginTop: SPACING.xl,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: '#FDECEC', borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm, marginBottom: SPACING.sm,
  },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Error, flex: 1,
  },
});
