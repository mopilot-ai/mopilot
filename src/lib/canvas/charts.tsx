// Offline SVG charts keep canvas series, category labels, legends and exact values available without a chart service.
import type { CSSProperties } from 'react';
import { withKeys } from '../listKeys';
import { toneColor, usageColorSequence, colorPalette } from './theme';
type Series = { name: string; data: number[]; tone?: string };
type Chart = {
  categories: string[];
  series: Series[];
  height?: number;
  valuePrefix?: string;
  valueSuffix?: string;
  showValues?: boolean;
  beginAtZero?: boolean;
  yMin?: number;
  yMax?: number;
  referenceLines?: { value: number; label?: string; tone?: string }[];
  style?: CSSProperties;
};
const color = (series: { tone?: string }, index: number) =>
  series.tone ? `var(--${toneColor(series.tone)})` : colorPalette[usageColorSequence[index % usageColorSequence.length]];
const valueLabel = (value: number, props: Chart) => `${props.valuePrefix ?? ''}${Number(value.toFixed(2))}${props.valueSuffix ?? ''}`;
function Legend({ series }: { series: { name: string; tone?: string }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 'var(--canvas-small)' }}>
      {withKeys(series, (item) => item.name).map(({ key, item, index }) => (
        <span key={key}>
          <span style={{ color: color(item, index) }}>● </span>
          {item.name}
        </span>
      ))}
    </div>
  );
}
function plot(props: Chart, stacked: boolean, normalized: boolean) {
  const rows = props.categories.map((_, index) => {
    const values = props.series.map((series) => series.data[index] ?? 0);
    const total = values.reduce((sum, value) => sum + Math.abs(value), 0);
    return normalized && total ? values.map((value) => (value / total) * 100) : values;
  });
  const extrema = stacked
    ? rows.flatMap((row) => [row.filter((v) => v < 0).reduce((a, b) => a + b, 0), row.filter((v) => v > 0).reduce((a, b) => a + b, 0)])
    : rows.flat();
  extrema.push(...(props.referenceLines ?? []).map((line) => line.value));
  const low = stacked
    ? Math.min(...extrema, 0)
    : (props.yMin ?? Math.min(...extrema, ...(props.beginAtZero === false && extrema.length ? [] : [0])));
  const high = normalized
    ? Math.max(100, ...(props.referenceLines ?? []).map((line) => line.value))
    : stacked
      ? Math.max(...extrema, 0)
      : (props.yMax ?? Math.max(...extrema, 0));
  const min = Number.isFinite(low) ? low : 0;
  const max = high > min ? high : min + 1;
  return { rows, min, max, scale: (value: number) => (value - min) / (max - min) };
}
export function BarChart(props: Chart & { stacked?: boolean; normalized?: boolean; horizontal?: boolean }) {
  const { categories, series, height = 260, normalized = false, horizontal = false, style } = props;
  const stacked = normalized || props.stacked === true;
  const showValues = !stacked && (props.showValues ?? (series.length === 1 && categories.length <= 8));
  const { rows, min, max, scale } = plot(props, stacked, normalized);
  const width = 640,
    left = horizontal ? 150 : 70,
    top = 20,
    innerWidth = width - left - 20,
    innerHeight = height - 70;
  const band = (horizontal ? innerHeight : innerWidth) / Math.max(categories.length, 1);
  const group = stacked ? 1 : Math.max(series.length, 1);
  return (
    <figure style={{ margin: 0, ...style }}>
      <svg
        role="img"
        aria-label={series.map((s) => s.name).join(', ')}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height }}
      >
        {[0, 0.5, 1].map((tick) => (
          <text
            key={tick}
            x={horizontal ? left + tick * innerWidth : left - 8}
            y={horizontal ? top + innerHeight + 30 : top + (1 - tick) * innerHeight}
            textAnchor={horizontal ? 'middle' : 'end'}
            fill="currentColor"
            fontSize="11"
          >
            {valueLabel(min + tick * (max - min), normalized ? { ...props, valuePrefix: '', valueSuffix: '%' } : props)}
          </text>
        ))}
        {withKeys(categories, String).map(({ key, index: row }) => {
          const values = rows[row];
          let positive = 0,
            negative = 0;
          return (
            <g key={key}>
              <text
                x={horizontal ? left - 8 : left + band * (row + 0.5)}
                y={horizontal ? top + band * (row + 0.5) : top + innerHeight + 16}
                textAnchor={horizontal ? 'end' : 'middle'}
                fill="currentColor"
                fontSize="10"
              >
                {categories[row]}
              </text>
              {withKeys(series, (item) => item.name).map(({ key, index }) => {
                const value = values[index];
                const start = stacked ? (value < 0 ? negative : positive) : 0;
                if (stacked) {
                  if (value < 0) negative += value;
                  else positive += value;
                }
                const from = Math.max(0, Math.min(1, scale(start))),
                  to = Math.max(0, Math.min(1, scale(start + value)));
                const category = band * row + band * 0.1 + (stacked ? 0 : (index * band * 0.8) / group);
                const thickness = (band * 0.8) / group;
                const x = horizontal ? left + Math.min(from, to) * innerWidth : left + category;
                const y = horizontal ? top + category : top + (1 - Math.max(from, to)) * innerHeight;
                const label = `${categories[row]} · ${series[index].name}: ${valueLabel(value, normalized ? { ...props, valuePrefix: '', valueSuffix: '%' } : props)}`;
                return (
                  <g key={key}>
                    <rect
                      x={x}
                      y={y}
                      width={horizontal ? Math.abs(to - from) * innerWidth : thickness}
                      height={horizontal ? thickness : Math.abs(to - from) * innerHeight}
                      fill={color(series[index], index)}
                    >
                      <title>{label}</title>
                    </rect>
                    {showValues && (
                      <text x={x + 3} y={y + 12} fontSize="10" fill="currentColor">
                        {valueLabel(value, props)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {withKeys(props.referenceLines ?? [], (line) => JSON.stringify([line.value, line.label])).map(({ key, item: line }) => {
          const position = horizontal ? left + scale(line.value) * innerWidth : top + (1 - scale(line.value)) * innerHeight;
          return (
            <g key={key}>
              <line
                x1={horizontal ? position : left}
                x2={horizontal ? position : left + innerWidth}
                y1={horizontal ? top : position}
                y2={horizontal ? top + innerHeight : position}
                stroke={`var(--${toneColor(line.tone)})`}
                strokeDasharray="4 4"
              />
              <text x={horizontal ? position : left} y={horizontal ? top - 5 : position - 5} fill="currentColor" fontSize="11">
                {line.label}
              </text>
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
    </figure>
  );
}
export function LineChart(props: Chart & { fill?: boolean; showHoverGuide?: boolean }) {
  const { categories, series, height = 260, fill = false, showValues = false, referenceLines = [], style } = props;
  const { min, max, scale } = plot(props, false, false);
  const left = 70,
    top = 20,
    width = 540,
    innerHeight = height - 70;
  const x = (index: number) => left + (index * width) / Math.max(categories.length - 1, 1);
  const y = (value: number) => top + (1 - scale(value)) * innerHeight;
  return (
    <figure style={{ margin: 0, ...style }}>
      <svg role="img" aria-label={series.map((s) => s.name).join(', ')} viewBox={`0 0 640 ${height}`} style={{ width: '100%', height }}>
        {withKeys([min, (min + max) / 2, max], String).map(({ key, item: tick }) => (
          <text key={key} x={left - 8} y={y(tick)} textAnchor="end" fontSize="11" fill="currentColor">
            {valueLabel(tick, props)}
          </text>
        ))}
        {withKeys(categories, String).map(({ key, item: label, index }) => (
          <text key={key} x={x(index)} y={height - 26} textAnchor="middle" fontSize="10" fill="currentColor">
            {label}
          </text>
        ))}
        {withKeys(referenceLines, (line) => JSON.stringify([line.value, line.label])).map(({ key, item: line }) => (
          <g key={key}>
            <line
              x1={left}
              x2={left + width}
              y1={y(line.value)}
              y2={y(line.value)}
              stroke={`var(--${toneColor(line.tone)})`}
              strokeDasharray="4 4"
            />
            <text x={left} y={y(line.value) - 5} fill="currentColor" fontSize="11">
              {line.label}
            </text>
          </g>
        ))}
        {withKeys(series, (item) => item.name).map(({ key, item, index }) => {
          const values = categories.map((_, i) => item.data[i] ?? 0);
          const points = values.map((value, i) => `${x(i)},${y(value)}`).join(' ');
          return (
            <g key={key}>
              {fill && (
                <polygon
                  points={`${left},${y(min)} ${points} ${x(values.length - 1)},${y(min)}`}
                  fill={color(item, index)}
                  opacity={0.12}
                />
              )}
              <polyline points={points} fill="none" stroke={color(item, index)} strokeWidth={2} />
              {withKeys(categories, String).map(({ key, index: i }) => (
                <g key={key}>
                  <circle cx={x(i)} cy={y(values[i])} r={3} fill={color(item, index)}>
                    <title>
                      {categories[i]} · {item.name}: {valueLabel(values[i], props)}
                    </title>
                  </circle>
                  {showValues && (
                    <text x={x(i)} y={y(values[i]) - 8} textAnchor="middle" fontSize="10" fill="currentColor">
                      {valueLabel(values[i], props)}
                    </text>
                  )}
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
    </figure>
  );
}
export function PieChart({
  data,
  size = 200,
  donut = false,
  style,
}: {
  data: { label: string; value: number; tone?: string }[];
  size?: number;
  donut?: boolean;
  style?: CSSProperties;
}) {
  const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const radius = size * (donut ? 0.35 : 0.25),
    circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <figure style={{ margin: 0, ...style }}>
      <svg
        role="img"
        aria-label={data.map((item) => `${item.label}: ${item.value}`).join(', ')}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
      >
        {withKeys(data, (item) => item.label).map(({ key, item, index }) => {
          const length = total ? (Math.max(0, item.value) / total) * circumference : 0;
          const segment = (
            <circle
              key={key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={color(item, index)}
              strokeWidth={size * (donut ? 0.18 : 0.5)}
              strokeDasharray={`${length} ${circumference}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            >
              <title>
                {item.label}: {item.value}
              </title>
            </circle>
          );
          offset += length;
          return segment;
        })}
      </svg>
      <Legend series={data.map((item) => ({ ...item, name: item.label }))} />
    </figure>
  );
}
