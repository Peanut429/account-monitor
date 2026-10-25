import { formatCompact, formatFullTs, formatNumber, formatTs } from "~/lib/format";

type Point = { ts: number; value: number | null };

export function LineChart({
  title,
  points,
  color = "#2563eb",
  unit = "",
}: {
  title: string;
  points: Point[];
  color?: string;
  unit?: string;
}) {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const valid = sorted.filter((point): point is { ts: number; value: number } => point.value != null);

  if (!valid.length) {
    return (
      <div className="chart-card card">
        <div className="chart-head">
          <span>{title}</span>
          <span className="chart-last">暂无数据</span>
        </div>
        <div className="chart-empty">这个指标还没有快照</div>
      </div>
    );
  }

  const width = 640;
  const height = 180;
  const pad = { top: 14, right: 14, bottom: 26, left: 48 };
  const minTs = valid[0].ts;
  const maxTs = valid[valid.length - 1].ts;
  const maxV = Math.max(...valid.map((point) => point.value), 1);

  const x = (ts: number) => pad.left + (maxTs === minTs
    ? (width - pad.left - pad.right) / 2
    : ((ts - minTs) / (maxTs - minTs)) * (width - pad.left - pad.right));
  const y = (value: number) => pad.top + (1 - value / maxV) * (height - pad.top - pad.bottom);

  let path = "";
  let penDown = false;
  for (const point of sorted) {
    if (point.value == null) {
      penDown = false;
      continue;
    }
    path += `${penDown ? "L" : "M"}${x(point.ts).toFixed(1)},${y(point.value).toFixed(1)} `;
    penDown = true;
  }

  const last = valid[valid.length - 1].value;
  const tickLabel = (value: number) => (
    value >= 10_000 ? formatCompact(value) : formatNumber(Math.round(value))
  );

  return (
    <div className="chart-card card">
      <div className="chart-head">
        <span>{title}</span>
        <span className="chart-last">{formatNumber(last)}{unit}</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {[0, 0.5, 1].map((ratio) => {
          const value = maxV * ratio;
          const lineY = y(value);
          return (
            <g key={ratio}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={lineY}
                y2={lineY}
                className="chart-grid-line"
              />
              <text x={pad.left - 8} y={lineY + 3} textAnchor="end" className="chart-axis-text">
                {tickLabel(value)}
              </text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {valid.map((point, index) => (
          <circle
            key={`${point.ts}-${index}`}
            cx={x(point.ts)}
            cy={y(point.value)}
            r="2.5"
            fill={color}
          >
            <title>{`${formatFullTs(point.ts)} · ${formatNumber(point.value)}${unit}`}</title>
          </circle>
        ))}
        <text x={pad.left} y={height - 8} className="chart-axis-text">{formatTs(minTs)}</text>
        <text x={width - pad.right} y={height - 8} textAnchor="end" className="chart-axis-text">{formatTs(maxTs)}</text>
      </svg>
    </div>
  );
}
