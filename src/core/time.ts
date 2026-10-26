export function nowTsMs(): number {
  return Date.now();
}

export function isoText(tsMs: number): string {
  return new Date(tsMs).toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把平台上的 "1.2K" / "1,234" / "1.2万" / "1.2亿" 这类文本转成数字。
 * 解析不了返回 null，不猜。
 */
export function parseCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const match = text.match(/^([\d.,]+)\s*([KkMmBb万千亿]?)/);
  if (!match) return null;

  const numeric = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;

  const suffix = match[2];
  const multiplier =
    suffix === "K" || suffix === "k" ? 1_000
      : suffix === "M" || suffix === "m" ? 1_000_000
        : suffix === "B" || suffix === "b" ? 1_000_000_000
          : suffix === "万" ? 10_000
            : suffix === "亿" ? 100_000_000
              : 1;

  return Math.round(numeric * multiplier);
}

export function errorCodeForMessage(message: unknown): string {
  const text = String(message || "");
  if (/login|登录|sign in|未登录|authenticate/i.test(text)) return "LOGIN_REQUIRED";
  if (/FACEBOOK_FIRST_SCREEN_TIMEOUT/i.test(text)) return "FACEBOOK_FIRST_SCREEN_TIMEOUT";
  if (/FACEBOOK_FIRST_SCREEN_PARSE_EMPTY/i.test(text)) return "FACEBOOK_FIRST_SCREEN_PARSE_EMPTY";
  if (/timeout|超时/i.test(text)) return "TIMEOUT";
  if (/没有.*adapter|尚未实现|not implemented/i.test(text)) return "NO_ADAPTER";
  return "SCRAPE_FAILED";
}
