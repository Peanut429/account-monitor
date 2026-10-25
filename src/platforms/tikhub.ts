import { sleep } from "../core/time.ts";

const BASE_URL = "https://api.tikhub.io";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
let lastRequestAt = 0;

export class TikHubError extends Error {
  status: number;
  code: number | string;
  requestId: string;
  body: string;

  constructor(message: string, meta: { status?: number; code?: number | string; requestId?: string; body?: string } = {}) {
    super(message);
    this.name = "TikHubError";
    this.status = meta.status ?? 0;
    this.code = meta.code ?? "";
    this.requestId = meta.requestId ?? "";
    this.body = meta.body ?? "";
  }
}

function apiKey(): string {
  const key = process.env.TIKHUB_API_KEY || "";
  if (!key) throw new Error("缺少 TIKHUB_API_KEY，4 个 API 平台都需要它");
  return key;
}

export async function tikHubGet<T = any>(
  path: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
  label = path,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const key = apiKey();
  const minIntervalMs = Number(process.env.TIKHUB_MIN_INTERVAL_MS || 80);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();

      let json: any;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new TikHubError(`TikHub ${label} 返回非 JSON：HTTP ${response.status}`, {
          status: response.status,
          body: text.slice(0, 1_000),
        });
      }

      const apiCode = Number(json?.code ?? 200);
      const dataStatus = json?.data && typeof json.data === "object" && !Array.isArray(json.data)
        ? json.data.status
        : undefined;
      const failed = !response.ok || apiCode !== 200 || dataStatus === false;

      if (failed) {
        const message = json?.message_zh || json?.message || json?.detail?.message || text.slice(0, 300);
        const error = new TikHubError(
          `TikHub ${label} 失败：HTTP ${response.status} code=${apiCode} ${message}`.trim(),
          {
            status: response.status,
            code: apiCode,
            requestId: json?.request_id,
            body: text.slice(0, 1_000),
          },
        );

        if ((response.status === 429 || response.status >= 500 || apiCode === 429) && attempt < 2) {
          lastError = error;
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw error;
      }

      return json as T;
    } catch (error: any) {
      if (error instanceof TikHubError) throw error;
      lastError = error;
      if (attempt < 2) {
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      throw new Error(`TikHub ${label} 请求失败：${error?.message || String(error)}`);
    }
  }

  throw lastError || new Error(`TikHub ${label} 请求失败`);
}

export function platformHandleFromUrl(profileUrl: string): string {
  try {
    const parts = new URL(profileUrl).pathname.split("/").filter(Boolean);
    return (parts[0] || "").replace(/^@/, "");
  } catch {
    return "";
  }
}
