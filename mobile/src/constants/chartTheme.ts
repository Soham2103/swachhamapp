/**
 * Chart tokens for the Super Admin dashboard.
 *
 * The two channel colours are a CATEGORICAL pair — they encode identity
 * (B2B vs B2C), not magnitude — so they are assigned in fixed order and
 * never cycled or reassigned by rank. If a filter ever hides one series
 * the other keeps its colour.
 *
 * The pair was validated rather than eyeballed, against the white card
 * surface these charts sit on:
 *
 *   lightness band        PASS
 *   chroma floor          PASS  (neither reads as grey)
 *   CVD separation        PASS  ΔE 19.8 protan / 34.5 tritan  (floor is 8)
 *   normal-vision floor   PASS  ΔE 30.8
 *   contrast vs surface   PASS  both >= 3:1
 *
 * The brand green (#2D6A4F) was the obvious first choice and FAILED: its
 * chroma is 0.078, under the floor, so it reads grey in a chart, and
 * green-vs-amber is a classic protan confusion (ΔE 7.0). Brand colour
 * stays on the chrome; the data gets colours that can actually be told
 * apart. Green is still the app's identity everywhere around the chart.
 */
export const CHANNEL_COLORS = {
  B2B: '#0891B2',
  B2C: '#EA580C',
} as const;

export type Channel = keyof typeof CHANNEL_COLORS;

/** Fixed assignment order. A third channel would need re-validation. */
export const CHANNEL_ORDER: Channel[] = ['B2B', 'B2C'];

export const CHANNEL_LABELS: Record<Channel, string> = {
  B2B: 'Business',
  B2C: 'Customer',
};

/**
 * Grid and axes stay recessive so the data is the loudest thing on the
 * card. Text always wears a text token, never a series colour — the
 * coloured mark beside a label is what carries identity.
 */
export const CHART = {
  gridLine: '#E8EFEA',
  axisLine: '#D6E2DA',
  axisText: '#6B7280',
  valueText: '#12211A',
  strokeWidth: 2,
  markerRadius: 4,
  barRadius: 4,
  /** Surface gap between adjacent fills, per mark spec. */
  markGap: 2,
} as const;

/** Compact money for axis ticks and tiles: 1234 -> ₹1.2k */
export function formatCurrencyShort(value: number): string {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}k`;
  return `₹${n.toFixed(0)}`;
}

export function formatCurrency(value: number): string {
  return `₹${(Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
