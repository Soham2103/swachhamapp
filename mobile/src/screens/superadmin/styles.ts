import { StyleSheet } from 'react-native';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';

/**
 * Shared chrome for the super admin screens, so the section reads as one
 * surface instead of five screens that drifted apart.
 */
export const sa = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.Background, padding: SPACING.lg,
  },
  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold', color: COLORS.TextPrimary, flex: 1,
  },
  iconBtn: { padding: SPACING.xs },

  card: {
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md, marginBottom: SPACING.sm,
    borderWidth: 1, borderColor: COLORS.Border,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.TextPrimary,
  },
  cardMeta: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary, marginTop: 2,
  },
  /** One detail line inside a card, e.g. a field returned by GST lookup. */
  cardLine: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary, marginTop: 4,
  },

  tabs: {
    flexDirection: 'row', gap: SPACING.xs,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm,
  },
  tab: {
    flex: 1, minHeight: 40, paddingVertical: SPACING.sm, borderRadius: BORDER_RADIUS.md,
    alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.Surface,
    borderWidth: 1, borderColor: COLORS.Border,
  },
  tabActive: { backgroundColor: COLORS.Primary, borderColor: COLORS.Primary },
  tabText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.TextSecondary,
  },
  tabTextActive: { color: COLORS.Surface },

  label: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600', color: COLORS.TextSecondary,
    marginBottom: SPACING.xs, marginTop: SPACING.sm,
  },
  required: { color: COLORS.Error },
  input: {
    backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md, paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  inputMissing: { borderColor: COLORS.Warning, backgroundColor: '#FFF9F0' },

  button: {
    backgroundColor: COLORS.Primary, borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.lg,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.Surface,
  },

  rowBtns: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  approve: {
    flex: 1, backgroundColor: COLORS.Success, borderRadius: BORDER_RADIUS.md,
    minHeight: 44, paddingVertical: SPACING.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  reject: {
    flex: 1, backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Error,
    borderRadius: BORDER_RADIUS.md, minHeight: 44, paddingVertical: SPACING.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  approveText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.Surface,
  },
  rejectText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.Error,
  },

  /* Status is never colour alone: every pill carries its own word. */
  pill: {
    alignSelf: 'flex-start', paddingHorizontal: SPACING.sm, paddingVertical: 2,
    borderRadius: BORDER_RADIUS.full, marginTop: 4,
  },
  pillText: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: 10, fontWeight: '700' },

  empty: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary, textAlign: 'center', marginTop: SPACING.xl,
  },

  /* ---- Table ----
   *
   * Wide content scrolls inside its own horizontal ScrollView so the
   * page itself never scrolls sideways; the columns keep their widths
   * on a narrow phone instead of wrapping into an unreadable stack.
   */
  tableWrap: {
    backgroundColor: COLORS.Surface, borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1, borderColor: COLORS.Border, overflow: 'hidden',
  },
  tableHeadRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.Background,
    borderBottomWidth: 1, borderBottomColor: COLORS.Border,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm,
  },
  tableRow: {
    flexDirection: 'row', alignItems: 'center',
    borderBottomWidth: 1, borderBottomColor: COLORS.Border,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm,
  },
  th: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: 11, fontWeight: '700',
    color: COLORS.TextSecondary, letterSpacing: 0.5,
  },
  td: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  tdMuted: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
  /** A price, so the digits line up down the column. */
  tdPrice: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700', color: COLORS.TextPrimary, textAlign: 'right',
  },
  /* Row actions were a 4pt-padded icon: about 28pt of target, under the 44pt
     everyone recommends. Widened here rather than per-screen so every table
     gets it. Still compact — this is a dense table, not a toolbar. */
  rowAction: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---- Bottom-sheet modal, the same shape the invoice modal uses ---- */
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: COLORS.Background,
    borderTopLeftRadius: BORDER_RADIUS.lg,
    borderTopRightRadius: BORDER_RADIUS.lg,
    paddingBottom: SPACING.lg,
    maxHeight: '88%',
  },
  /** A selectable option inside a picker list. */
  choice: {
    minHeight: 46,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md, borderWidth: 1, borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface, marginBottom: SPACING.xs,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
  },
  choiceActive: { borderColor: COLORS.Primary, backgroundColor: '#E6F4EC' },
  choiceText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary, flex: 1,
  },
  /* ---- Filters ----
   *
   * A horizontally scrolling strip of chips. One row of vertical space no
   * matter how many filters a screen has, and the page never scrolls
   * sideways because the strip owns its own overflow.
   */
  filterBar: {
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  filterChip: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
  },
  filterChipOn: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  filterChipText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600', color: COLORS.TextPrimary,
  },
  filterChipTextOn: { color: COLORS.Surface, fontWeight: '800' },

  /** A field that opens a picker — looks like a select, behaves like a button. */
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
    marginBottom: SPACING.xs,
  },
  selectRowFilled: { borderColor: COLORS.Primary, backgroundColor: '#F1F9F4' },
  selectValue: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  selectPlaceholder: { color: COLORS.TextSecondary },
  selectDisabled: { opacity: 0.5 },

  /** Secondary button: same size as `button`, quieter. */
  buttonGhost: {
    backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md, paddingVertical: SPACING.md,
    alignItems: 'center', marginTop: SPACING.sm,
  },
  buttonGhostText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.TextPrimary,
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
  warnBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: '#FFF4E5', borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm, marginBottom: SPACING.sm,
  },
  warnText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: '#8A5200', flex: 1,
  },

  /* ---- Table row actions, as labelled buttons ----
   *
   * A bare icon in a dense table is quick to scan but slow to be sure of:
   * "trash" and "toggle" both read as "something destructive". These carry
   * the word as well, at a comfortable target size -- deliberately a little
   * larger than the icon-only `rowAction`, not so large that six of them
   * stop fitting on a row. */
  actionBtn: {
    minHeight: 38,
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: SPACING.xs + 2,
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionBtnText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  actionBtnPrimary: { borderColor: COLORS.Primary, backgroundColor: '#F1F9F4' },
  actionBtnDanger: { borderColor: COLORS.Error, backgroundColor: '#FDECEC' },

  /** The full-width primary action above a table, e.g. "+ Add New Entry". */
  addEntryBtn: {
    backgroundColor: COLORS.Primary,
    borderRadius: BORDER_RADIUS.md,
    minHeight: 48,
    paddingVertical: SPACING.sm + 4,
    paddingHorizontal: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  addEntryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.Surface,
  },

  /** An inline "can't find it? create one" affordance under a picker. */
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    marginTop: SPACING.xs,
  },
  linkText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.Primary,
  },

  /** A read-only value shown where an input would otherwise be. */
  readOnlyBox: {
    backgroundColor: COLORS.Background,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  readOnlyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
});

export const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  PENDING: { bg: '#FFF4E5', fg: '#8A5200' },
  ACTIVE: { bg: '#E6F4EC', fg: '#1B4332' },
  APPROVED: { bg: '#E6F4EC', fg: '#1B4332' },
  REJECTED: { bg: '#FDECEC', fg: '#8A1C1C' },
  INACTIVE: { bg: '#EEF1F0', fg: '#4B5563' },
};
