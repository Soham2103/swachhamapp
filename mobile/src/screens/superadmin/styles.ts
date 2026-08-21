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

  tabs: {
    flexDirection: 'row', gap: SPACING.xs,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm,
  },
  tab: {
    flex: 1, paddingVertical: SPACING.sm, borderRadius: BORDER_RADIUS.md,
    alignItems: 'center', backgroundColor: COLORS.Surface,
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
    paddingVertical: SPACING.sm, alignItems: 'center',
  },
  reject: {
    flex: 1, backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Error,
    borderRadius: BORDER_RADIUS.md, paddingVertical: SPACING.sm, alignItems: 'center',
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
});

export const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  PENDING: { bg: '#FFF4E5', fg: '#8A5200' },
  ACTIVE: { bg: '#E6F4EC', fg: '#1B4332' },
  APPROVED: { bg: '#E6F4EC', fg: '#1B4332' },
  REJECTED: { bg: '#FDECEC', fg: '#8A1C1C' },
  INACTIVE: { bg: '#EEF1F0', fg: '#4B5563' },
};
