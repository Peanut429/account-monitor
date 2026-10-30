/**
 * 离线回归 LinkedIn sdui 分页抓取循环（不需要登录、不连数据库）。
 *
 *   pnpm run li:pag
 *
 * 覆盖：
 * A. 正常分页：切“最新”先给一页，滚动继续给页，滚到窗口起点前停止；
 * B. 滚到底没有新分页请求：连续 3 轮到底后停止，不无限滚；
 * C. 发起了分页请求但一直拿不到响应：连续 3 轮后停止；
 * D. 切到“最新”后第一页已经早于窗口起点：取完这一页直接停，不再滚。
 */
import { collectPaginationBodies } from "../src/platforms/linkedin.ts";

let virtualNow = 1_700_000_000_000;
Date.now = () => virtualNow;

const realSetTimeout = setTimeout;
function tick(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

/** 用 snowflake 位运算造一个对应时间的 activityId。 */
function activityIdAt(tsMs: number): string {
  return String((BigInt(Math.round(tsMs)) << 22n) | 1n);
}

/** 造一份最小 RSC body：只要含 activity URN，minPublishMs/activityIdsFromRsc 就能解析。 */
function rscBody(tsListMs: number[]): string {
  return tsListMs.map((ts, index) => `${index + 1}:"urn:li:activity:${activityIdAt(ts)}"`).join("\n");
}

type FakeState = {
  queue: string[];
  requestCount: number;
  scrolls: number;
  moved: boolean;
  scenario: "pages" | "bottom" | "no-response" | "done";
  pageIndex: number;
  pages: number[][];
};

function createPage(state: FakeState) {
  const listeners: Array<(request: { url: () => string }) => void> = [];
  const page: any = {
    on(event: string, fn: (request: { url: () => string }) => void) {
      if (event === "request") listeners.push(fn);
    },
    off() {},
    async waitForTimeout(ms: number) {
      virtualNow += Math.max(0, Number(ms) || 0);
      await tick();
    },
    async evaluate(fn: any) {
      const src = String(fn);
      if (src.includes("__liPagBodies")) {
        const copy = [...state.queue];
        state.queue = [];
        return copy;
      }
      if (src.includes("scrollHeight")) {
        state.scrolls += 1;
        if (state.scenario === "bottom") return false;
        if (state.scenario === "pages" && state.scrolls % 3 === 0) {
          state.requestCount += 1;
          for (const listener of listeners) {
            listener({ url: () => "https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?x=1" });
          }
          const next = state.pages[state.pageIndex];
          if (next) {
            state.pageIndex += 1;
            realSetTimeout(() => {
              state.queue.push(rscBody(next));
            }, 0);
          }
        }
        return true;
      }
      return null;
    },
    async waitForFunction(fn: any) {
      // 对齐 Playwright 语义：条件不满足时不会 resolve(false)，而是等到超时抛错。
      if (state.queue.length > 0) return true;
      throw new Error("Timeout");
    },
  };
  return page;
}

async function run(name: string, state: FakeState, docTimes: number[], sinceTsMs: number) {
  const page = createPage(state);
  const started = virtualNow;
  const bodies = await collectPaginationBodies(page, sinceTsMs, rscBody(docTimes));
  console.log(`\n=== ${name} ===`);
  console.log(`bodies=${bodies.length} requests=${state.requestCount} scrolls=${state.scrolls} 虚拟耗时=${Math.round((virtualNow - started) / 1000)}s`);
  return bodies;
}

const now = Date.parse("2026-10-31T04:00:00Z");
const since = now - 72 * 3_600_000;

// A. 三页分页，最后一页早于窗口起点
const stateA: FakeState = {
  queue: [],
  requestCount: 0,
  scrolls: 0,
  moved: true,
  scenario: "pages",
  pageIndex: 0,
  pages: [
    [now - 1 * 3_600_000, now - 2 * 3_600_000],
    [now - 20 * 3_600_000, now - 40 * 3_600_000],
    [now - 80 * 3_600_000, now - 90 * 3_600_000],
  ],
};
const bodiesA = await run("正常分页，滚过窗口起点停止", stateA, [now], since);
if (bodiesA.length !== 3) throw new Error(`场景 A 失败：bodies=${bodiesA.length}`);
if (stateA.pageIndex !== 3) throw new Error(`场景 A 失败：pageIndex=${stateA.pageIndex}`);
if (stateA.scrolls > 40) throw new Error(`场景 A 失败：滚动次数异常 ${stateA.scrolls}`);

// B. 滚到底，没有分页请求
const stateB: FakeState = { queue: [], requestCount: 0, scrolls: 0, moved: true, scenario: "bottom", pageIndex: 0, pages: [] };
const bodiesB = await run("滚到底没有新请求", stateB, [now], since);
if (bodiesB.length !== 0) throw new Error(`场景 B 失败：bodies=${bodiesB.length}`);
if (stateB.scrolls > 40) throw new Error(`场景 B 失败：滚动次数异常 ${stateB.scrolls}`);

// C. 有请求但没有响应
const stateC: FakeState = {
  queue: [],
  requestCount: 0,
  scrolls: 0,
  moved: true,
  scenario: "pages",
  pageIndex: 0,
  // 不投递 body：模拟“发起了分页请求但响应一直没到”
  pages: [],
};
const bodiesC = await run("发起分页请求但拿不到响应", stateC, [now], since);
if (bodiesC.length !== 0) throw new Error(`场景 C 失败：bodies=${bodiesC.length}`);
if (stateC.scrolls > 40) throw new Error(`场景 C 失败：滚动次数异常 ${stateC.scrolls}`);

// D. 切“最新”后的第一页已经早于窗口起点
const stateD: FakeState = {
  queue: [rscBody([now - 100 * 3_600_000])],
  requestCount: 0,
  scrolls: 0,
  moved: true,
  scenario: "bottom",
  pageIndex: 0,
  pages: [],
};
const bodiesD = await run("最新第一页已早于窗口起点", stateD, [now - 100 * 3_600_000], since);
if (bodiesD.length !== 1) throw new Error(`场景 D 失败：bodies=${bodiesD.length}`);
console.log("\n全部通过");
