import type { PlatformAdapter } from "./types.ts";
import { facebookAdapter } from "./facebook.ts";
import { instagramAdapter } from "./instagram.ts";
import { linkedinAdapter } from "./linkedin.ts";
import { tiktokAdapter } from "./tiktok.ts";
import { xAdapter } from "./x.ts";
import { youtubeAdapter } from "./youtube.ts";

const adapters: Record<string, PlatformAdapter> = {
  x: xAdapter,
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  linkedin: linkedinAdapter,
  tiktok: tiktokAdapter,
};

export function getAdapter(platformCode: string): PlatformAdapter | null {
  return adapters[platformCode] || null;
}

export function adapterCodes(): string[] {
  return Object.keys(adapters);
}
