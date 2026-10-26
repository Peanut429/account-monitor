import type { BrowserContext, Page } from "playwright";
import { loadEnvFile } from "../config/env.ts";
import { openBrowser } from "../core/browser.ts";
import { errorCodeForMessage } from "../core/time.ts";
import { closeDb } from "../db/client.ts";
import {
  createCycle,
  createRun,
  finishCycle,
  finishRun,
  listAccounts,
  releaseCycleLock,
  saveRunResult,
  tryAcquireCycleLock,
  writeLog,
} from "../db/repo.ts";
import { getAdapter } from "../platforms/registry.ts";
import type { AccountRow } from "../platforms/types.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const eq = current.indexOf("=");
    if (eq > 0) {
      out[current.slice(2, eq)] = current.slice(eq + 1);
      continue;
    }
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时（${ms}ms）`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  const windowHours = Number(args["window-hours"] || process.env.MONITOR_WINDOW_HOURS || 72);
  // 默认不按 account_type 过滤：库里 active = true 的账号全部监控。
  // --account-type 只作为临时调试过滤条件保留。
  const accountType = args["account-type"] || "";
  const timeoutMs = Number(process.env.MONITOR_ACCOUNT_TIMEOUT_MS || 300_000);
  const concurrency = Math.max(1, Number(args.concurrency || process.env.MONITOR_CONCURRENCY || 3));
  const platformFilter = (args.platform || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const untilTsMs = Date.now();
  const sinceTsMs = untilTsMs - windowHours * 3_600_000;

  let locked = false;
  let cycleId: string | null = null;
  let context: BrowserContext | null = null;
  let browserError: string | null = null;
  let accounts: AccountRow[] = [];
  let failed = 0;

  try {
    locked = await tryAcquireCycleLock();
    if (!locked) {
      console.log("上一轮监控还没结束，本轮跳过。");
      return;
    }

    accounts = await listAccounts(accountType || null);
    if (platformFilter.length) {
      accounts = accounts.filter((account) => platformFilter.includes(account.platformCode));
    }
    if (args.account) {
      accounts = accounts.filter((account) => account.handle === args.account);
    }
    if (args.limit) {
      accounts = accounts.slice(0, Number(args.limit));
    }
    if (!accounts.length) {
      throw new Error(accountType
        ? `没有找到 account_type=${accountType} 的启用账号`
        : "没有找到启用账号");
    }

    cycleId = await createCycle(sinceTsMs, untilTsMs);
    console.log(
      `周期 ${cycleId}：${accounts.length} 个账号，`
      + `窗口 ${new Date(sinceTsMs).toISOString()} → ${new Date(untilTsMs).toISOString()}，并发 ${concurrency}`,
    );
    await writeLog({
      cycleId,
      level: "info",
      step: "cycle_start",
      message: `开始周期：${accounts.length} 个账号`,
      extra: { context: { accountType: accountType || "all", windowHours, concurrency, platformFilter } },
    });

    const needsBrowser = accounts.some((account) => {
      const adapter = getAdapter(account.platformCode);
      return adapter ? adapter.needsPage !== false : true;
    });
    if (needsBrowser) {
      try {
        context = await openBrowser();
      } catch (error) {
        browserError = error instanceof Error ? error.message : String(error);
        await writeLog({
          cycleId,
          level: "error",
          step: "browser_start_failed",
          message: `浏览器启动失败，Facebook/LinkedIn 本轮会失败：${browserError}`,
        });
        console.error(`浏览器启动失败：${browserError}`);
      }
    }

    await mapLimit(accounts, concurrency, async (account) => {
      const runId = await createRun(cycleId as string, account);
      const startedTsMs = Date.now();
      let page: Page | null = null;

      try {
        const adapter = getAdapter(account.platformCode);
        if (!adapter) {
          throw new Error(`没有 ${account.platformCode} 的 adapter（尚未实现）`);
        }

        if (adapter.needsPage !== false) {
          if (!context) {
            throw new Error(browserError || "这个平台需要浏览器，但浏览器没有初始化");
          }
          page = await context.newPage();
          page.setDefaultTimeout(45_000);
        }

        const result = await withTimeout(
          adapter.scrapeAccount({
            page,
            account,
            sinceTsMs,
            untilTsMs,
            log: async (level, step, message, extra) => {
              await writeLog({
                cycleId,
                runId,
                level,
                step,
                message,
                extra,
              });
            },
          }),
          timeoutMs,
          `${account.platformCode}/${account.handle}`,
        );

        const saved = await saveRunResult({
          runId,
          account,
          posts: result.posts,
          accountMetrics: result.accountMetrics,
          capturedTsMs: Date.now(),
        });
        await finishRun({
          runId,
          status: "success",
          postsFound: result.posts.length,
          postsSaved: saved,
        });
        await writeLog({
          cycleId,
          runId,
          level: "info",
          step: "run_done",
          message: `完成：窗口内 ${result.posts.length} 条，入库 ${saved} 条，耗时 ${Date.now() - startedTsMs}ms`,
        });
        console.log(`[ok] ${account.platformCode}/${account.handle}: ${result.posts.length} 条，${Date.now() - startedTsMs}ms`);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = errorCodeForMessage(message);
        await finishRun({
          runId,
          status: "failed",
          postsFound: 0,
          postsSaved: 0,
          errorCode,
          errorMessage: message,
        });
        await writeLog({
          cycleId,
          runId,
          level: "error",
          step: "run_failed",
          message,
          extra: { errorCode, pageUrl: page?.url() },
        });
        console.error(`[fail] ${account.platformCode}/${account.handle}: ${message}`);
      } finally {
        await page?.close().catch(() => {});
      }
    });

    const status = failed === 0 ? "success" : failed === accounts.length ? "failed" : "partial_failed";
    await finishCycle({ cycleId, status });
    await writeLog({
      cycleId,
      level: "info",
      step: "cycle_done",
      message: `周期结束：${status}，失败 ${failed}/${accounts.length}`,
    });
    console.log(`周期结束：${status}，失败 ${failed}/${accounts.length}`);
    if (failed > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cycleId) {
      await finishCycle({ cycleId, status: "failed", errorMessage: message }).catch(() => {});
    }
    console.error(message);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    if (locked) await releaseCycleLock().catch(() => {});
    await closeDb().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
