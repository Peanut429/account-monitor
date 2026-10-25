const TIME_ZONE = "Asia/Shanghai";

const numberFormatter = new Intl.NumberFormat("zh-CN");

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return numberFormatter.format(value);
}

const compactFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return compactFormatter.format(value);
}

export function formatTs(tsMs: number | null | undefined): string {
  if (!tsMs) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(tsMs));
}

export function formatFullTs(tsMs: number | null | undefined): string {
  if (!tsMs) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(tsMs));
}

export function formatRelative(tsMs: number | null | undefined): string {
  if (!tsMs) return "—";
  const diff = Date.now() - tsMs;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (abs < 60_000) return "刚刚";
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`;
  return `${Math.round(abs / 86_400_000)} 天${suffix}`;
}

export function formatDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value > 0 ? `+${numberFormatter.format(value)}` : numberFormatter.format(value);
}

export function deltaClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "delta-flat";
  return value > 0 ? "delta-up" : "delta-down";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

export function formatInterval(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function truncate(value: string | null | undefined, length = 140): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
