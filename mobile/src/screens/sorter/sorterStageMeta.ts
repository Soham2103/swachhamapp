import { COLORS } from '../../constants/theme';
import { SorterStage } from '../../services/sorterApi';

/**
 * How each stage is labelled and coloured across the Sorter module.
 *
 * Kept in its own module so the home screen, the requests list and the order
 * detail all read the same source. `SorterDashboardScreen` re-exports it, so
 * existing imports from that screen keep working.
 */
export const STAGE_META: Record<SorterStage, { label: string; color: string }> = {
  confirmed: { label: 'CONFIRMED', color: COLORS.Info },
  accepted: { label: 'ACCEPTED', color: COLORS.Warning },
  ready: { label: 'READY', color: COLORS.Success },
  // Some items finished, some still being worked on. Warned rather than
  // greened: the order needs coming back to.
  partially_completed: { label: 'PARTLY READY', color: COLORS.Warning },
  out_for_delivery: { label: 'OUT FOR DELIVERY', color: COLORS.Primary },
};
