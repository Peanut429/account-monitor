/**
 * 离线验证 Facebook 首屏“用时超出预期”重试逻辑。
 * 用假 page 驱动 adapter，时钟虚拟化，不连浏览器/数据库。
 *
 *   pnpm run fb:retry
 *
 * 覆盖：
 * A. 首次首屏卡死（骨架屏 + 用时超出预期）→ 重载 1 次后恢复，帖子解析正常；
 * B. 一直卡死 → 重试耗尽后抛 FACEBOOK_FIRST_SCREEN_TIMEOUT，warn 日志齐全；
 * C. FACEBOOK_FIRST_SCREEN_RETRIES=0 → 只加载 1 次就直接失败；
 * D. 没有“用时超出预期”文案但 20s 没有卡片 → 同样重载重试；
 * E. DOM 卡片没渲染、但接口已抓到帖子 → 不重载，帖子不能丢。
 *
 * 任意场景断言失败都会抛错，进程退出码非 0。
 */
import { facebookAdapter } from "../src/platforms/facebook.ts";

type LogEntry = { level: string; step: string; message: string; extra?: any };

let virtualNow = 1_700_000_000_000;
Date.now = () => virtualNow;

const realSetTimeout = setTimeout;

function tick(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

function graphqlBody(publishedMs: number): string {
  const story = {
    __typename: "Story",
    creation_time: Math.floor(publishedMs / 1000),
    comet_sections: {
      content: {
        story: {
          wwwURL: "https://www.facebook.com/byd/posts/123456",
          post_id: "123456",
          message: { text: "hello changan" },
          actors: [{ url: "https://www.facebook.com/byd" }],
        },
      },
      feedback: {
        story: {
          story_ufi_container: {
            story: {
              feedback_context: {
                feedback_target_with_context: {
                  comet_ufi_summary_and_actions_renderer: {
                    feedback: {
                      reaction_count: { count: 8 },
                      comments_count_summary_renderer: {
                        feedback: { comment_rendering_instance: { comments: { total_count: 1 } } },
                      },
                      share_count: { count: 2 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  return JSON.stringify({ data: { node: story } });
}

function createPage(opts: {
  cards: () => number;
  stalled: () => boolean;
  emitPost?: boolean;
  emitOnLoad?: number;
}) {
  let loadCount = 0;
  let emitted = false;
  const listeners: Array<(response: any) => void> = [];
  const logs: LogEntry[] = [];

  const page: any = {
    on(event: string, fn: (response: any) => void) {
      if (event === "response") listeners.push(fn);
    },
    off() {},
    url() {
      return "https://www.facebook.com/byd/";
    },
    async goto() {
      loadCount += 1;
      maybeEmit();
    },
    async reload() {
      loadCount += 1;
      maybeEmit();
    },
    async waitForTimeout(ms: number) {
      virtualNow += Math.max(0, Number(ms) || 0);
      // 让真实的 macrotask（比如假接口的 setTimeout 回包）有机会执行
      await tick();
    },
    async waitForLoadState() {},
    async waitForFunction() {},
    getByRole() {
      return { first: () => ({ count: async () => 0, click: async () => {} }) };
    },
    keyboard: { press: async () => {} },
    mouse: { wheel: async () => {} },
    async close() {},
    async evaluate(fn: any) {
      const src = String(fn);
      if (src.includes("stalled")) {
        return { cards: opts.cards(), stalled: opts.stalled() };
      }
      if (src.includes('role="dialog"')) return false;
      if (src.includes("headingY")) return [];
      if (src.includes("loginForm")) {
        return { loginForm: false, loginGate: false, loggedInNav: true, sample: "" };
      }
      if (src.includes("h1")) {
        return { name: "BYD", followersText: "110000", followingText: "12", pageUrl: "https://www.facebook.com/byd/" };
      }
      if (src.includes("innerHeight")) return 1200;
      if (src.includes("scrollY")) return { y: 0, h: 4000 };
      if (src.includes("TimelineFeedUnit")) return opts.cards();
      if (src.includes("innerText")) return "用时超出预期 加载中";
      return null;
    },
  };

  function maybeEmit(): void {
    if (!opts.emitPost || emitted || loadCount < (opts.emitOnLoad ?? 2)) return;
    emitted = true;
    realSetTimeout(() => {
      for (const listener of listeners) {
        listener({
          url: () => "https://www.facebook.com/api/graphql/",
          text: async () => graphqlBody(virtualNow - 3_600_000),
        });
      }
    }, 0);
  }

  return { page, logs, getLoadCount: () => loadCount };
}

const account = {
  id: "acc-1",
  platformCode: "facebook",
  handle: "byd",
  displayName: "BYD",
  profileUrl: "https://www.facebook.com/byd/",
};

const sinceTsMs = virtualNow - 72 * 3_600_000;
const untilTsMs = virtualNow;

async function runOnce(name: string, page: any, logs: LogEntry[]) {
  console.log(`\n=== ${name} ===`);
  const started = virtualNow;
  try {
    const result = await facebookAdapter.scrapeAccount({
      page,
      account,
      sinceTsMs,
      untilTsMs,
      log: async (level, step, message, extra) => {
        logs.push({ level, step, message, extra });
      },
    });
    console.log(`ok posts=${result.posts.length} followers=${result.accountMetrics.followers}`);
    console.log(`steps=${logs.map((item) => item.step).join(",")}`);
    console.log(`虚拟耗时=${Math.round((virtualNow - started) / 1000)}s`);
    return result;
  } catch (error) {
    console.log(`throw: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`steps=${logs.map((item) => item.step).join(",")}`);
    console.log(`虚拟耗时=${Math.round((virtualNow - started) / 1000)}s`);
    return null;
  }
}

const scenarioA = createPage({
  cards: () => (scenarioA.getLoadCount() >= 2 ? 1 : 0),
  stalled: () => scenarioA.getLoadCount() < 2,
  emitPost: true,
});
const resultA = await runOnce("首次卡死，重载后恢复", scenarioA.page, scenarioA.logs);
const retriesA = scenarioA.logs.filter((item) => item.step === "facebook_retry");
if (!resultA || resultA.posts.length !== 1) throw new Error("场景 A 失败：重载后没有解析到帖子");
if (retriesA.length !== 1 || scenarioA.getLoadCount() !== 2) throw new Error(`场景 A 失败：重试次数不对 loads=${scenarioA.getLoadCount()} retries=${retriesA.length}`);
if (!/用时超出预期/.test(retriesA[0].message)) throw new Error("场景 A 失败：重试日志没有带卡死原因");
console.log("场景 A 通过");

const scenarioB = createPage({ cards: () => 0, stalled: () => true });
const resultB = await runOnce("一直卡死，重试耗尽后失败", scenarioB.page, scenarioB.logs);
const retriesB = scenarioB.logs.filter((item) => item.step === "facebook_retry");
if (resultB) throw new Error("场景 B 失败：应该抛错");
// 初次 1 次 + 软 reload 1 次 + 硬重载（about:blank + 主页）2 次
if (retriesB.length !== 2 || scenarioB.getLoadCount() !== 4) throw new Error(`场景 B 失败：loads=${scenarioB.getLoadCount()} retries=${retriesB.length}`);
if (!scenarioB.logs.some((item) => item.level === "warn")) throw new Error("场景 B 失败：没有 warn 日志");
console.log("场景 B 通过");

process.env.FACEBOOK_FIRST_SCREEN_RETRIES = "0";
const scenarioC = createPage({ cards: () => 0, stalled: () => true });
const resultC = await runOnce("关闭重试", scenarioC.page, scenarioC.logs);
const retriesC = scenarioC.logs.filter((item) => item.step === "facebook_retry");
delete process.env.FACEBOOK_FIRST_SCREEN_RETRIES;
if (resultC) throw new Error("场景 C 失败：应该抛错");
if (retriesC.length !== 0 || scenarioC.getLoadCount() !== 1) throw new Error(`场景 C 失败：loads=${scenarioC.getLoadCount()}`);
console.log("场景 C 通过");

const scenarioD = createPage({ cards: () => 0, stalled: () => false });
const resultD = await runOnce("没有提示但一直没卡片", scenarioD.page, scenarioD.logs);
if (resultD) throw new Error("场景 D 失败：应该抛错");
if (
  !scenarioD.logs.some((item) => item.step === "facebook_retry")
  || scenarioD.getLoadCount() !== 4
) throw new Error(`场景 D 失败：loads=${scenarioD.getLoadCount()}`);
console.log("场景 D 通过");

const scenarioE = createPage({
  cards: () => 0,
  stalled: () => false,
  emitPost: true,
  emitOnLoad: 1,
});
const resultE = await runOnce("卡片没渲染但接口有帖子（不应重载）", scenarioE.page, scenarioE.logs);
if (!resultE || resultE.posts.length !== 1) throw new Error("场景 E 失败：接口帖子没有保住");
if (scenarioE.logs.some((item) => item.step === "facebook_retry") || scenarioE.getLoadCount() !== 1) {
  throw new Error(`场景 E 失败：不该重载 loads=${scenarioE.getLoadCount()}`);
}
console.log("场景 E 通过");
