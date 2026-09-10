import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import ticketApi, {
  Ticket, TicketMeta, TicketFilters, TicketStatus, TicketPriority, TicketCategory,
  PRIORITY_LABELS,
} from '../../services/ticketApi';
import { extractErrorMessage } from '../../services/api';

/**
 * THE TICKET LIST — one screen for every role.
 *
 * A Sorter sees the tickets it raised, a hotel sees its own, a Manager sees the
 * hotel tickets it answers plus its own, and the Super Admin sees all of them.
 * NONE of that is decided here: the server scopes the list from the token, so
 * this screen renders whatever comes back and cannot widen it.
 *
 * The Raise button is shown when the server says the caller may raise
 * (`meta.can_raise` — false for the Super Admin, who answers rather than
 * raises), so the app never carries its own copy of that rule either.
 */

const STATUS_TONE: Record<TicketStatus, { bg: string; fg: string }> = {
  OPEN: { bg: '#FDECEC', fg: '#B42318' },
  IN_PROGRESS: { bg: '#FFF4E5', fg: '#8A5200' },
  WAITING_FOR_RESPONSE: { bg: '#EEF2FF', fg: '#3538CD' },
  RESOLVED: { bg: '#E8F3EC', fg: '#1B4332' },
  CLOSED: { bg: '#F1F3F5', fg: '#5B6470' },
};

const PRIORITY_TONE: Record<TicketPriority, string> = {
  LOW: '#6B7280',
  MEDIUM: '#2D6A4F',
  HIGH: '#B85C00',
  URGENT: '#B42318',
};

const STATUS_ORDER: TicketStatus[] = [
  'OPEN', 'IN_PROGRESS', 'WAITING_FOR_RESPONSE', 'RESOLVED', 'CLOSED',
];

function when(value: string) {
  const d = new Date(value);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString(
    'en-IN', { hour: '2-digit', minute: '2-digit' }
  )}`;
}

export default function TicketsScreen({ navigation }: any) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [meta, setMeta] = useState<TicketMeta | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState<TicketFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = useCallback(
    async (next: TicketFilters = filters) => {
      try {
        setError('');
        const [list, m] = await Promise.all([
          ticketApi.list(next),
          meta ? Promise.resolve({ data: meta } as any) : ticketApi.meta(),
        ]);
        setTickets(list.data.tickets);
        setTotal(list.data.total);
        if (!meta) setMeta(m.data);
      } catch (e: any) {
        setError(extractErrorMessage(e, 'Could not load tickets'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filters, meta]
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  /** One filter changed. The list reloads from the server, never in memory. */
  const apply = (patch: Partial<TicketFilters>) => {
    const next = { ...filters, ...patch };
    for (const key of Object.keys(next) as Array<keyof TicketFilters>) {
      if (next[key] === '' || next[key] === undefined) delete next[key];
    }
    setFilters(next);
    setLoading(true);
    load(next);
  };

  const activeFilters = Object.keys(filters).length;

  const renderTicket = ({ item }: { item: Ticket }) => {
    const tone = STATUS_TONE[item.status] || STATUS_TONE.OPEN;
    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('TicketDetailScreen', { ticketId: item.id })}
        accessibilityRole="button"
        accessibilityLabel={`Ticket ${item.ticket_number}, ${item.title}, ${item.status_label}`}
      >
        <View style={styles.cardTop}>
          <Text style={styles.ticketNumber}>{item.ticket_number}</Text>
          <View style={[styles.statusPill, { backgroundColor: tone.bg }]}>
            <Text style={[styles.statusText, { color: tone.fg }]}>{item.status_label}</Text>
          </View>
        </View>

        <Text style={styles.title} numberOfLines={2}>{item.title}</Text>

        <View style={styles.metaRow}>
          <Text style={styles.category}>{item.category_label}</Text>
          <Text style={[styles.priority, { color: PRIORITY_TONE[item.priority] }]}>
            {PRIORITY_LABELS[item.priority]}
          </Text>
        </View>

        {(item.business_name || item.order_number) ? (
          <Text style={styles.meta} numberOfLines={1}>
            {item.business_name || '—'}
            {item.order_number ? ` · ${item.order_number}` : ''}
          </Text>
        ) : null}

        <View style={styles.cardFoot}>
          <Text style={styles.meta}>
            {item.created_by_name} ({item.created_by_role}) · {when(item.created_at)}
          </Text>
          {item.message_count > 0 ? (
            <View style={styles.replyCount}>
              <Ionicons name="chatbubble-outline" size={12} color={COLORS.TextSecondary} />
              <Text style={styles.meta}>{item.message_count}</Text>
            </View>
          ) : null}
        </View>

        {item.assigned_to_name ? (
          <Text style={styles.assigned}>Assigned to {item.assigned_to_name}</Text>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Tickets</Text>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => setFiltersOpen((v) => !v)}
          accessibilityLabel="Filters"
        >
          <Ionicons name="funnel-outline" size={20} color={COLORS.TextPrimary} />
          {activeFilters > 0 ? (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{activeFilters}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      </View>

      {filtersOpen ? (
        <View style={styles.filterPanel}>
          <TextInput
            style={styles.input}
            placeholder="Ticket number"
            placeholderTextColor={COLORS.TextSecondary}
            defaultValue={filters.ticket_number || ''}
            onSubmitEditing={(e) => apply({ ticket_number: e.nativeEvent.text })}
            returnKeyType="search"
            accessibilityLabel="Filter by ticket number"
          />
          <TextInput
            style={styles.input}
            placeholder="Order number"
            placeholderTextColor={COLORS.TextSecondary}
            defaultValue={filters.order_number || ''}
            onSubmitEditing={(e) => apply({ order_number: e.nativeEvent.text })}
            returnKeyType="search"
            accessibilityLabel="Filter by order number"
          />
          <View style={styles.dateRow}>
            <TextInput
              style={[styles.input, styles.dateInput]}
              placeholder="From (YYYY-MM-DD)"
              placeholderTextColor={COLORS.TextSecondary}
              defaultValue={filters.date_from || ''}
              onSubmitEditing={(e) => apply({ date_from: e.nativeEvent.text })}
              accessibilityLabel="Filter from date"
            />
            <TextInput
              style={[styles.input, styles.dateInput]}
              placeholder="To (YYYY-MM-DD)"
              placeholderTextColor={COLORS.TextSecondary}
              defaultValue={filters.date_to || ''}
              onSubmitEditing={(e) => apply({ date_to: e.nativeEvent.text })}
              accessibilityLabel="Filter to date"
            />
          </View>

          <Text style={styles.filterLabel}>Status</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip on={!filters.status} label="All" onPress={() => apply({ status: '' })} />
            {STATUS_ORDER.map((s) => (
              <Chip
                key={s}
                on={filters.status === s}
                label={meta?.status_labels?.[s] || s}
                onPress={() => apply({ status: filters.status === s ? '' : s })}
              />
            ))}
          </ScrollView>

          <Text style={styles.filterLabel}>Priority</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip on={!filters.priority} label="All" onPress={() => apply({ priority: '' })} />
            {(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as TicketPriority[]).map((p) => (
              <Chip
                key={p}
                on={filters.priority === p}
                label={PRIORITY_LABELS[p]}
                onPress={() => apply({ priority: filters.priority === p ? '' : p })}
              />
            ))}
          </ScrollView>

          <Text style={styles.filterLabel}>Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip on={!filters.category} label="All" onPress={() => apply({ category: '' })} />
            {Object.entries(meta?.category_labels || {}).map(([value, label]) => (
              <Chip
                key={value}
                on={filters.category === value}
                label={String(label)}
                onPress={() =>
                  apply({ category: filters.category === value ? '' : (value as TicketCategory) })
                }
              />
            ))}
          </ScrollView>

          {activeFilters > 0 ? (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => { setFilters({}); setLoading(true); load({}); }}
            >
              <Text style={styles.clearText}>CLEAR ALL FILTERS</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {!!error && (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <FlatList
          data={tickets}
          keyExtractor={(t) => t.id}
          renderItem={renderTicket}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              colors={[COLORS.Primary]}
            />
          }
          ListHeaderComponent={
            total > 0 ? <Text style={styles.count}>{total} ticket(s)</Text> : null
          }
          ListEmptyComponent={
            <View style={styles.centered}>
              <Ionicons name="ticket-outline" size={40} color={COLORS.TextSecondary} />
              <Text style={styles.empty}>
                {activeFilters > 0 ? 'No tickets match these filters.' : 'No tickets yet.'}
              </Text>
            </View>
          }
        />
      )}

      {meta?.can_raise ? (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('CreateTicketScreen')}
          accessibilityRole="button"
          accessibilityLabel="Raise a ticket"
        >
          <Ionicons name="add" size={26} color={COLORS.Surface} />
        </TouchableOpacity>
      ) : null}
    </SafeAreaView>
  );
}

function Chip({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, on && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    backgroundColor: COLORS.Surface, borderBottomWidth: 1, borderBottomColor: COLORS.Border,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold', color: COLORS.TextPrimary,
  },
  iconBtn: { padding: SPACING.xs },
  filterBadge: {
    position: 'absolute', top: 0, right: 0, minWidth: 16, height: 16,
    borderRadius: 8, backgroundColor: COLORS.Primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  filterBadgeText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 10, fontWeight: '800', color: COLORS.Surface,
  },

  filterPanel: {
    backgroundColor: COLORS.Surface, padding: SPACING.md, gap: SPACING.xs,
    borderBottomWidth: 1, borderBottomColor: COLORS.Border,
  },
  filterLabel: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700', color: COLORS.TextSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: SPACING.xs,
  },
  input: {
    borderWidth: 1, borderColor: COLORS.Border, borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs,
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary, backgroundColor: COLORS.Surface,
  },
  dateRow: { flexDirection: 'row', gap: SPACING.xs },
  dateInput: { flex: 1 },
  chipRow: { gap: SPACING.xs, paddingVertical: 2 },
  chip: {
    paddingHorizontal: SPACING.sm, paddingVertical: 6, borderRadius: BORDER_RADIUS.full,
    borderWidth: 1, borderColor: COLORS.Border, backgroundColor: COLORS.Surface,
  },
  chipOn: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  chipText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  chipTextOn: { color: COLORS.Surface },
  clearBtn: { alignSelf: 'flex-start', marginTop: SPACING.xs },
  clearText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '800', color: COLORS.Error, letterSpacing: 0.4,
  },

  list: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: 96 },
  count: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary, marginBottom: SPACING.xs,
  },
  card: {
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, gap: 4, ...SHADOWS.light,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ticketNumber: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800', color: COLORS.PrimaryDark, letterSpacing: 0.4,
  },
  statusPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: BORDER_RADIUS.full },
  statusText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, fontWeight: '800' },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700', color: COLORS.TextPrimary,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  category: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.Primary,
  },
  priority: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs, fontWeight: '800' },
  meta: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs, color: COLORS.TextSecondary,
  },
  cardFoot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 2,
  },
  replyCount: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  assigned: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Primary, fontWeight: '600',
  },

  centered: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xl, gap: SPACING.sm },
  empty: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    margin: SPACING.md, padding: SPACING.sm,
    backgroundColor: '#FDECEC', borderRadius: BORDER_RADIUS.sm,
  },
  errorText: {
    flex: 1, fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.Error,
  },

  fab: {
    position: 'absolute', right: SPACING.lg, bottom: SPACING.lg,
    width: 56, height: 56, borderRadius: 28, backgroundColor: COLORS.Primary,
    alignItems: 'center', justifyContent: 'center', ...SHADOWS.light,
  },
});
