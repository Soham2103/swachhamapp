import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, LayoutChangeEvent } from 'react-native';
import Svg, { Path, Line, Circle } from 'react-native-svg';
import {
  CHANNEL_COLORS,
  CHANNEL_ORDER,
  CHANNEL_LABELS,
  CHART,
  formatCurrencyShort,
  formatCurrency,
} from '../../constants/chartTheme';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';

export interface RevenuePoint {
  period: string;
  b2b_revenue: number;
  b2c_revenue: number;
  b2b_orders: number;
  b2c_orders: number;
}

interface Props {
  points: RevenuePoint[];
  height?: number;
}

const PAD = { top: 12, right: 12, bottom: 22, left: 44 };

/**
 * Revenue over time, one line per channel.
 *
 * A line is the right form because the question is change over time.
 * Both channels are always drawn even when one is flat at zero --
 * dropping an empty series would quietly imply it does not exist, when
 * "no B2C revenue this month" is itself the finding.
 *
 * One y-axis, never two. Both series are rupees on the same scale, so
 * they belong on one axis; a second scale would let the shapes be
 * compared when the magnitudes cannot be.
 *
 * Touch is this platform's hover: dragging across the plot moves a
 * crosshair and reads out both channels for that day.
 */
export default function RevenueLineChart({ points, height = 180 }: Props) {
  const [width, setWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = Math.max(0, height - PAD.top - PAD.bottom);

  const { maxY, xFor, yFor, paths } = useMemo(() => {
    const values = points.flatMap((p) => [p.b2b_revenue, p.b2c_revenue]);
    // A flat-zero series would collapse the scale, so keep a floor of 1.
    const rawMax = Math.max(1, ...values);
    // Round the top up so the axis lands on a readable number.
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const top = Math.ceil(rawMax / magnitude) * magnitude;

    const x = (i: number) =>
      PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

    const build = (key: 'b2b_revenue' | 'b2c_revenue') =>
      points
        .map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(2) + ' ' + y(p[key]).toFixed(2))
        .join(' ');

    return {
      maxY: top,
      xFor: x,
      yFor: y,
      paths: { B2B: build('b2b_revenue'), B2C: build('b2c_revenue') },
    };
  }, [points, plotW, plotH]);

  function selectFromX(locationX: number) {
    if (points.length === 0 || plotW <= 0) return;
    const ratio = Math.min(1, Math.max(0, (locationX - PAD.left) / plotW));
    setActiveIndex(Math.round(ratio * (points.length - 1)));
  }

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => selectFromX(e.nativeEvent.locationX),
        onPanResponderMove: (e) => selectFromX(e.nativeEvent.locationX),
        onPanResponderRelease: () => setActiveIndex(null),
        onPanResponderTerminate: () => setActiveIndex(null),
      }),
    [points, plotW]
  );

  if (points.length === 0) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>No sales in this period</Text>
      </View>
    );
  }

  const active = activeIndex !== null ? points[activeIndex] : null;
  const gridValues = [0, 0.5, 1].map((f) => maxY * f);

  return (
    <View onLayout={onLayout}>
      {width > 0 && (
        <View {...panResponder.panHandlers}>
          <Svg width={width} height={height}>
            {gridValues.map((v) => (
              <Line
                key={'g' + v}
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={yFor(v)}
                y2={yFor(v)}
                stroke={CHART.gridLine}
                strokeWidth={1}
              />
            ))}

            {activeIndex !== null && (
              <Line
                x1={xFor(activeIndex)}
                x2={xFor(activeIndex)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke={CHART.axisLine}
                strokeWidth={1}
              />
            )}

            {CHANNEL_ORDER.map((channel) => (
              <Path
                key={channel}
                d={paths[channel]}
                stroke={CHANNEL_COLORS[channel]}
                strokeWidth={CHART.strokeWidth}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            {activeIndex !== null &&
              CHANNEL_ORDER.map((channel) => {
                const value =
                  channel === 'B2B'
                    ? points[activeIndex].b2b_revenue
                    : points[activeIndex].b2c_revenue;
                return (
                  <Circle
                    key={'m' + channel}
                    cx={xFor(activeIndex)}
                    cy={yFor(value)}
                    r={CHART.markerRadius}
                    fill={CHANNEL_COLORS[channel]}
                    stroke={COLORS.Surface}
                    strokeWidth={CHART.markGap}
                  />
                );
              })}
          </Svg>

          {gridValues.map((v) => (
            <Text key={'l' + v} style={[styles.axisLabel, { top: yFor(v) - 7 }]}>
              {formatCurrencyShort(v)}
            </Text>
          ))}
          <Text style={[styles.xLabel, { left: PAD.left }]}>{points[0].period.slice(5)}</Text>
          <Text style={[styles.xLabel, styles.xLabelEnd]}>
            {points[points.length - 1].period.slice(5)}
          </Text>
        </View>
      )}

      <View style={styles.readout}>
        {active ? (
          <>
            <Text style={styles.readoutDate}>{active.period}</Text>
            {CHANNEL_ORDER.map((channel) => (
              <View key={channel} style={styles.readoutRow}>
                <View style={[styles.swatch, { backgroundColor: CHANNEL_COLORS[channel] }]} />
                <Text style={styles.readoutLabel}>{CHANNEL_LABELS[channel]}</Text>
                <Text style={styles.readoutValue}>
                  {formatCurrency(channel === 'B2B' ? active.b2b_revenue : active.b2c_revenue)}
                </Text>
              </View>
            ))}
          </>
        ) : (
          <Text style={styles.hint}>Touch and drag the chart to read a day</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center' },
  emptyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  axisLabel: {
    position: 'absolute',
    left: 0,
    width: PAD.left - 6,
    textAlign: 'right',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 10,
    color: CHART.axisText,
  },
  xLabel: {
    position: 'absolute',
    bottom: 0,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 10,
    color: CHART.axisText,
  },
  xLabelEnd: { right: PAD.right },
  readout: { marginTop: SPACING.sm, minHeight: 56, justifyContent: 'center' },
  readoutDate: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.TextSecondary,
    marginBottom: 2,
  },
  readoutRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  readoutLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    flex: 1,
  },
  readoutValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600',
    color: CHART.valueText,
  },
  hint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
});
