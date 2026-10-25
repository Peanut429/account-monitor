import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

export function browserUserDataDir(): string {
  return path.resolve(process.env.MONITOR_USER_DATA_DIR || "work/playwright-profile");
}

export function browserExecutablePath(): string | undefined {
  const configured = process.env.MONITOR_CHROME_EXECUTABLE || "";
  if (configured && fs.existsSync(configured)) return configured;
  return undefined;
}

export async function openBrowser(): Promise<BrowserContext> {
  const userDataDir = browserUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  const headless = process.env.MONITOR_HEADLESS === "1";
  return chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: browserExecutablePath(),
    viewport: headless ? { width: 1440, height: 1000 } : null,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}
