import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnvFile } from "../config/env.ts";
import { openBrowser } from "../core/browser.ts";

const LOGIN_URLS: Record<string, string> = {
  x: "https://x.com/home",
  youtube: "https://www.youtube.com/",
  instagram: "https://www.instagram.com/",
  facebook: "https://www.facebook.com/",
  linkedin: "https://www.linkedin.com/feed/",
  tiktok: "https://www.tiktok.com/",
};

function parsePlatform(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--platform") return argv[i + 1] || "";
    if (argv[i].startsWith("--platform=")) return argv[i].slice("--platform=".length);
  }
  return "";
}

async function main(): Promise<void> {
  loadEnvFile();
  const platform = parsePlatform(process.argv.slice(2));
  // X / YouTube / Instagram / TikTok 已改成 TikHub API，不需要登录浏览器。
  const browserPlatforms = ["facebook", "linkedin"];
  const targets = !platform || platform === "all" ? browserPlatforms : [platform];

  const context = await openBrowser();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (const code of targets) {
      const url = LOGIN_URLS[code];
      if (!url) throw new Error(`未知平台：${code}`);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch((error) => {
        console.log(`打开 ${url} 失败：${error.message}`);
      });
      console.log(`\n请在浏览器里登录 ${code}（${url}）。登录完成后回到终端按 Enter。`);
      await rl.question("");
      await page.close();
    }
  } finally {
    await rl.close();
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
