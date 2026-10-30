import type { Page, Request, Response } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";
import { activityIdsFromRsc, parseRscFeed, publishIsoFromActivityId } from "./linkedin-rsc-parser.ts";
import {
  parseLinkedInGraphqlCounts,
  parseLinkedInGraphqlPosts,
  type LinkedInGraphqlCounts,
  type LinkedInGraphqlPost,
} from "./linkedin-graphql-parser.ts";

function maxCount(...values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => value != null);
  return nums.length ? Math.max(...nums) : null;
}

type LinkedInMode = "rsc" | "graphql" | "dom";
let cachedLinkedInMode: LinkedInMode | null = null;
let modeProbeActive = false;
let modeProbePromise: Promise<void> | null = null;
let resolveModeProbe: (() => void) | null = null;

/** 每个 monitor 周期开头重置，保证一轮只判定一次。 */
export function resetLinkedInMode(): void {
  cachedLinkedInMode = null;
  modeProbeActive = false;
  modeProbePromise = null;
  resolveModeProbe = null;
}

async function claimModeProbe(): Promise<boolean> {
  if (cachedLinkedInMode) return false;
  if (!modeProbeActive) {
    modeProbeActive = true;
    modeProbePromise = new Promise((resolve) => {
      resolveModeProbe = resolve;
    });
    return true;
  }
  // 本轮已经有一个账号在判定；等它完成，避免并发 3 时前 3 个都各自探测。
  await Promise.race([
    modeProbePromise ?? Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 120_000)),
  ]);
  return false;
}

function finishModeProbe(): void {
  resolveModeProbe?.();
  resolveModeProbe = null;
  modeProbePromise = null;
  modeProbeActive = false;
}

type LinkedInCard = {
  activityId: string;
  text: string;
  countsText: string;
  labels: string[];
  isVideo: boolean;
  isImage: boolean;
};

function activityIdToTsMs(activityId: string): number | null {
  try {
    const id = BigInt(activityId);
    const ts = Number(id >> 22n);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

const LINKEDIN_REACTIONS_RE = /(?:([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:reactions?|likes?|人赞|个赞|次赞|点赞|赞)|(?:点赞|赞)\s*([\d.,]+\s*[KMBkmb万千亿]?))/i;
const LINKEDIN_COMMENTS_RE = /([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:comments?|条评论|次评论|评论)/i;
const LINKEDIN_SHARES_RE = /(?:([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:reposts?|shares?|次转发|次分享)|(?:转发了?|分享了?)\s*([\d.,]+\s*[KMBkmb万千亿]?)\s*次)/i;

function pickCount(labels: string[], countsText: string, pattern: RegExp): number | null {
  for (const value of [...labels, countsText]) {
    const match = pattern.exec(String(value || ""));
    if (!match) continue;
    // 有的正则有两个分支，数字可能在 match[2]
    for (let index = 1; index < match.length; index += 1) {
      if (match[index] == null) continue;
      const parsed = parseCount(match[index]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

/**
 * 只解析 LinkedIn 的点赞/评论/转发。
 *
 * 注意：DOM 里的 "22 次展示" 语义尚未在参考项目中定义，也没有证据表明
 * 它就是曝光数。它既不是点赞，也不写进 reads；只保留在 raw_json.labels。
 */
export function parseLinkedInCounts(labels: string[], countsText: string): {
  likes: number | null;
  comments: number | null;
  shares: number | null;
} {
  return {
    likes: pickCount(labels, countsText, LINKEDIN_REACTIONS_RE),
    comments: pickCount(labels, countsText, LINKEDIN_COMMENTS_RE),
    shares: pickCount(labels, countsText, LINKEDIN_SHARES_RE),
  };
}

async function readCards(page: Page): Promise<LinkedInCard[]> {
  return page.evaluate(() => {
    const text = (element: Element | null) => (element?.textContent || "").replace(/\s+/g, " ").trim();
    const out: LinkedInCard[] = [];
    const seen = new Set<string>();

    // 新版公司动态页的卡片不一定有 data-urn 了，activityId 可能只出现在链接 href
    // （/feed/update/urn:li:activity:123/）或者某个 data-* 属性里。所以身份改为
    // 从整张卡片的属性 + 链接 + 文案里正则提取，而不是死盯一个属性名。
    const pickActivityId = (card: Element, cardText: string): string => {
      const attributePairs: string[] = [];
      for (const element of [card, ...card.querySelectorAll("*")]) {
        if (!element.getAttributeNames) continue;
        for (const name of element.getAttributeNames()) {
          attributePairs.push(`${name}=${element.getAttribute(name) || ""}`);
        }
      }
      const hrefs = [...card.querySelectorAll("a[href]")].map((anchor) => (anchor as HTMLAnchorElement).href);
      const haystack = [...attributePairs, ...hrefs, cardText].join(" ");
      for (const pattern of [/urn:li:activity[:%3A](\d{8,})/i, /activity[:-](\d{8,})/i, /activityId[=:](\d{8,})/i]) {
        const match = haystack.match(pattern);
        if (match) return match[1];
      }
      return "";
    };

    // .feed-shared-update-v2 / div[role="article"] 是参考项目长期在用的卡片外层，
    // 比 data-urn 稳；data-urn 选择器保留，谁命中用谁。
    const nodes = [...document.querySelectorAll(
      '.feed-shared-update-v2, div[role="article"], [data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"]',
    )];
    // 只保留最内层候选，避免外层包裹节点把整页帖子的 id 都算到同一条上。
    const leaves = nodes.filter((node) => !nodes.some((other) => other !== node && node.contains(other)));
    for (const node of leaves) {
      const container = (node.closest(".feed-shared-update-v2") || node) as Element;
      const activityId = pickActivityId(container, text(container));
      if (!activityId || seen.has(activityId)) continue;
      seen.add(activityId);

      const counts = container.querySelector(".social-details-social-counts");
      // 新版 LinkedIn 的 reaction 数不一定在 .social-details-social-counts 的 button 里，
      // 有些在 aria-label 或整张卡片的文本里。这里放宽到整张卡片，避免漏掉 "25 人赞"。
      const labels = [...container.querySelectorAll("button, [aria-label]")]
        .map((element) => element.getAttribute("aria-label") || text(element))
        .filter(Boolean);

      // 有些版本只渲染一个裸数字（旁边是表情图标），没有 aria-label。
      const reactionCount = text(container.querySelector(".social-details-social-counts__reactions-count"));
      if (reactionCount) labels.push(`${reactionCount} 人赞`);

      out.push({
        activityId,
        text: text(container.querySelector(
          ".feed-shared-update-v2__description, .update-components-text, .feed-shared-text",
        )),
        countsText: text(counts),
        labels,
        isVideo: Boolean(container.querySelector(".update-components-video, .feed-shared-video, video")),
        isImage: Boolean(container.querySelector(".update-components-image, .feed-shared-image")),
      });
    }
    return out;
  });
}

async function readProfile(page: Page): Promise<{
  name: string;
  followersText: string;
  pageUrl: string;
}> {
  return page.evaluate(() => {
    const text = (element: Element | null) => (element?.textContent || "").replace(/\s+/g, " ").trim();
    const body = document.body.innerText;
    return {
      name: text(document.querySelector("h1")),
      followersText: /([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:位)?\s*(?:followers?|粉丝|关注者)/i.exec(body)?.[1] || "",
      pageUrl: location.href,
    };
  });
}

async function readLinkedInGraphqlBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as any;
    return Array.isArray(w.__liGraphqlBodies) ? w.__liGraphqlBodies : [];
  }).catch(() => []);
}

type LinkedInGraphqlCollector = {
  bodies: unknown[];
  stats: { apiResponses: number; feedResponses: number; sampleUrls: string[] };
};

/**
 * 用 Playwright 的 CDP 响应事件收集 voyager GraphQL 响应。
 *
 * 参考项目 linkedin-network.ts 一直用 page.on("response") 这条路，服务器上稳定；
 * 本项目之前只有 window.fetch 猴补丁，而 LinkedIn 的页面脚本会在启动时覆盖
 * window.fetch，导致 5 天里一条 GraphQL 都没抓到（interface_mode 恒为 dom）。
 * 两条路都留着：CDP 是主，猴补丁是备。
 */
function attachLinkedInGraphqlCollector(page: Page): LinkedInGraphqlCollector {
  const bodies: unknown[] = [];
  const stats = { apiResponses: 0, feedResponses: 0, sampleUrls: [] as string[] };

  const handler = (response: Response): void => {
    try {
      const url = new URL(response.url());
      if (!/linkedin\.com$/i.test(url.hostname)) return;
      if (!["fetch", "xhr"].includes(response.request().resourceType())) return;
      if (!/\/voyager\/api\/.*graphql\b/i.test(url.pathname) && !/\/graphql\b/i.test(url.pathname)) return;

      stats.apiResponses += 1;
      if (stats.sampleUrls.length < 6) stats.sampleUrls.push(url.pathname);
      void response.json().then((json) => {
        if (json && typeof json === "object") {
          bodies.push(json);
          stats.feedResponses += 1;
        }
      }).catch(() => {});
    } catch {
      // 单个响应取不到 body 不影响其它响应
    }
  };

  page.on("response", handler);
  // 账号跑完调用方会 close 页面，监听器随之释放，不需要单独 dispose。
  return { bodies, stats };
}

async function installLinkedInCapture(page: Page): Promise<void> {
  // LinkedIn 新版公司动态是 RSC/sdui：首屏数据随文档 SSR 下发，之后每页数据由
  // POST /flagship-web/rsc-action/actions/pagination 返回（每份 2-6MB）。
  // 必须在页面脚本执行前挂 fetch/XHR，clone 响应留一份；分页 body 由抓取端
  // 每轮 drain 取走并清空，不能一直堆在页面侧，否则 renderer 内存会持续上涨。
  // 注意：不能用 CDP 的 response.body()，会和页面自身的 fetch 抢 body，
  // 报 "No data found for resource with given identifier"，整页帖子被静默丢弃。
  await page.addInitScript(() => {
    const w = window as any;
    w.__liPagBodies = [];
    w.__liGraphqlBodies = [];

    const classify = (url: string): string | null => {
      if (/rsc-action\/actions\/pagination/.test(url)) return "__liPagBodies";
      if (/voyager\/api\/.*graphql/.test(url)) return "__liGraphqlBodies";
      return null;
    };
    const store = (key: string, text: string): void => {
      const target = w[key];
      if (!Array.isArray(target)) return;
      target.push(text);
      const cap = key === "__liPagBodies" ? 8 : 30;
      while (target.length > cap) target.shift();
    };

    const originalFetch = w.fetch.bind(w);
    w.fetch = (...args: any[]) => {
      const input = args[0];
      const url = typeof input === "string" ? input : input?.url || String(input);
      const key = classify(url);
      const promise = originalFetch(...args);
      if (key) {
        promise.then((response: any) => {
          response.clone().text().then((text: string) => store(key, text)).catch(() => {});
        }).catch(() => {});
      }
      return promise;
    };

    // 少量请求走 XHR，不只 fetch；同样捕获。
    const XHR = w.XMLHttpRequest;
    if (XHR) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      XHR.prototype.open = function (this: any, ...args: any[]) {
        this.__liRequestUrl = String(args[1] || "");
        return originalOpen.apply(this, args);
      };
      XHR.prototype.send = function (this: any, ...args: any[]) {
        this.addEventListener("load", () => {
          const key = classify(String(this.__liRequestUrl || ""));
          if (!key) return;
          try {
            const text = this.responseText;
            if (text) store(key, text);
          } catch {
            // ignore
          }
        });
        return originalSend.apply(this, args);
      };
    }
  });
}

async function ensureOnTargetCompanyPostsPage(page: Page, targetUrl: string): Promise<void> {
  const target = new URL(targetUrl);
  const expectedPath = target.pathname.replace(/\/+$/, "/");
  const isExpected = (value: string) => {
    try {
      const current = new URL(value);
      return /linkedin\.com$/i.test(current.hostname) && current.pathname.replace(/\/+$/, "/") === expectedPath;
    } catch {
      return false;
    }
  };
  if (isExpected(page.url())) return;
  await page.waitForTimeout(1_200);
  if (isExpected(page.url())) return;
  // LinkedIn 会把旧 slug 301 到新 slug（例如 byd-españa → byd-spain）。只要落地仍是
  // 某个公司的「动态」页就继续抓，具体跳转由调用方写日志；登录页/首页仍然拒绝。
  try {
    const actual = new URL(page.url());
    if (/linkedin\.com$/i.test(actual.hostname) && /^\/company\/[^/]+\/posts\/?$/i.test(actual.pathname)) return;
  } catch {
    // 非法 URL 走到下面抛错
  }
  throw new Error(`LinkedIn 打开后未停留在目标公司动态页。目标=${targetUrl} 实际=${page.url() || "空白页"}`);
}

async function scrollLinkedInFeed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("main, main *")]
      .filter((element) => element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 100);
    const primary = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!primary) return false;
    const maxTop = primary.scrollHeight - primary.clientHeight;
    const before = primary.scrollTop;
    // 步长小一点（约 0.35 屏），一屏分几步滚；一次跳太多会触发懒加载 catch-up，
    // LinkedIn 会直接跳过中间几页，导致漏帖。
    const step = Math.max(200, Math.round(primary.clientHeight * 0.35));
    primary.scrollTop = Math.min(maxTop, primary.scrollTop + step);
    primary.dispatchEvent(new Event("scroll", { bubbles: true }));
    primary.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
    return primary.scrollTop !== before;
  }).catch(() => false);
}

async function ensureSortRecent(page: Page): Promise<boolean> {
  // 新版页面用 #sort-dropdown-trigger；旧版是“排序条件”按钮。
  const direct = page.locator("#sort-dropdown-trigger").first();
  const fallback = page.locator('[role="button"]').filter({ hasText: /^排序条件|^Sort by/ }).first();
  const trigger = (await direct.count().catch(() => 0)) ? direct : fallback;
  if (!(await trigger.count().catch(() => 0))) return false;
  // sdui 首屏渲染比文档晚，排序控件晚一点出现是常态，等一会儿再判定。
  await trigger.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});

  const label = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/最新|最近|Recent/i.test(label)) return true;

  // sdui 下拉必须真实鼠标点击（DOM .click() 不触发），Playwright locator.click 可以。
  await trigger.click().catch(() => {});
  await page.waitForTimeout(1_200);
  const options = page.locator('[role="option"], [role="menuitem"]');
  await options.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  const count = await options.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    // 下拉里“切到最新”的文案是“最近搜索”，这里按 最近/最新 匹配。
    if (!/最近|最新|Recent/i.test(text)) continue;
    await option.click().catch(() => {});
    await page.waitForTimeout(3_000);
    return true;
  }
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

function minPublishMs(text: string): number {
  let min = Number.POSITIVE_INFINITY;
  if (!text) return min;
  for (const activityId of activityIdsFromRsc(text)) {
    const ts = Date.parse(publishIsoFromActivityId(activityId));
    if (Number.isFinite(ts) && ts < min) min = ts;
  }
  return min;
}

async function waitForPaginationBody(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const w = window as any;
        return Array.isArray(w.__liPagBodies) ? w.__liPagBodies.length > 0 : false;
      },
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/** 取走页面侧已捕获的分页 body 并立即清空，避免 6MB × N 堆在 renderer 里。 */
async function drainPaginationBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as any;
    const list = Array.isArray(w.__liPagBodies) ? w.__liPagBodies : [];
    w.__liPagBodies = [];
    return list;
  }).catch(() => []);
}

/**
 * 滚到「窗口起点」为止：每轮先小幅滚动直到页面发起新的 pagination 请求，
 * 等它的响应被 fetch 猴补丁捕获后取走。停的条件是最早一条帖子早于 sinceTsMs，
 * 或者滚到底 / 连续多轮没有新请求和新响应。
 */
// 仅供 scripts/probe-linkedin-pagination.ts 离线回归分页循环，生产路径只走 scrapeLinkedInInner。
export async function collectPaginationBodies(page: Page, sinceTsMs: number, docText: string): Promise<string[]> {
  const bodies: string[] = [];
  let requestCount = 0;
  const onRequest = (request: Request): void => {
    if (/rsc-action\/actions\/pagination/.test(request.url())) requestCount += 1;
  };
  page.on("request", onRequest);

  try {
    // 首屏文档是“热门”排序（顺序不可靠，可能夹着很早的旧帖），不能拿它判断是否滚到窗口起点；
    // 停止判断只看切到“最新”之后的 pagination 响应。
    let earliest = Number.POSITIVE_INFINITY;
    let noRequestStreak = 0;
    let noResponseStreak = 0;

    // 切“最新”时已经触发过一次 pagination（第一页），先把已捕获的 body 取走。
    for (const body of await drainPaginationBodies(page)) {
      bodies.push(body);
      earliest = Math.min(earliest, minPublishMs(body));
    }
    if (Number.isFinite(earliest) && earliest < sinceTsMs) return bodies;

    for (let round = 0; round < 300; round += 1) {
      const requestsBefore = requestCount;
      let sawNewRequest = false;
      let reachedBottom = false;

      for (let step = 0; step < 20; step += 1) {
        if (requestCount > requestsBefore) {
          sawNewRequest = true;
          break;
        }
        const moved = await scrollLinkedInFeed(page);
        await page.waitForTimeout(500);
        if (requestCount > requestsBefore) {
          sawNewRequest = true;
          break;
        }
        if (!moved) {
          reachedBottom = true;
          break;
        }
      }

      if (!sawNewRequest) {
        noRequestStreak += 1;
        if (reachedBottom && noRequestStreak >= 3) break;
        if (noRequestStreak >= 8) break;
        continue;
      }
      noRequestStreak = 0;

      if (!(await waitForPaginationBody(page, 15_000))) {
        noResponseStreak += 1;
        if (noResponseStreak >= 3) break;
        continue;
      }
      noResponseStreak = 0;

      // 等 sdui 把这一页渲染出来，再取 body。
      await page.waitForTimeout(2_000);
      for (const body of await drainPaginationBodies(page)) {
        bodies.push(body);
        earliest = Math.min(earliest, minPublishMs(body));
      }
      if (Number.isFinite(earliest) && earliest < sinceTsMs) break;
    }
  } finally {
    page.off("request", onRequest);
  }

  // 循环提前退出时，页面上可能还有没取走的分页响应。
  bodies.push(...(await drainPaginationBodies(page)));
  return bodies;
}

async function scrapeLinkedInInner({
  page,
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  if (!page) throw new Error("LinkedIn adapter 需要浏览器页面");

  await log("info", "open_profile", `打开 ${account.profileUrl}`, { pageUrl: account.profileUrl });

  await installLinkedInCapture(page);
  // GraphQL 收集器保留为老页面兜底；新版 sdui 页面不会返回公司帖子。
  const network = attachLinkedInGraphqlCollector(page);

  const navResponse = await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const navStatus = navResponse?.status() ?? 0;
  // 新版 sdui 页面把首屏公司动态随文档 SSR 下发，文档本身就是数据源。
  // 文档里多一层 `\"` 转义，反转义后才能正常抽出帖子编号和互动计数。
  const docText = navResponse ? (await navResponse.text().catch(() => "")).replace(/\\+"/g, "\"") : "";
  await page.waitForTimeout(3_000);

  if (/\/login\b|\/authwall\b|\/checkpoint\b/i.test(page.url())) {
    throw new Error(`LinkedIn 未登录或需要验证：${account.profileUrl}`);
  }
  await ensureOnTargetCompanyPostsPage(page, account.profileUrl);
  if (page.url() && page.url() !== account.profileUrl) {
    await log("warn", "url_redirect", `LinkedIn 跳转到 ${page.url()}`, { pageUrl: page.url() });
  }

  const sortedRecent = await ensureSortRecent(page);
  await log("info", "sort_recent", sortedRecent ? "LinkedIn 动态已确认/切换为最近" : "未找到 LinkedIn 排序控件，保持当前排序");

  // 切到「最新」本身就会触发一次 pagination（新版第一页），之后滚动继续拿下一页。
  // 停不停看「最早一条帖子是否早于 72h 窗口起点」，不再按滚动轮数猜。
  const paginationBodies = await collectPaginationBodies(page, sinceTsMs, docText);
  const earliestPublishMs = (paginationBodies.length ? paginationBodies : [docText])
    .map((body) => minPublishMs(body))
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
  await log(
    "info",
    "pagination",
    `LinkedIn 分页响应 ${paginationBodies.length} 份，分页里最早帖子 `
    + `${Number.isFinite(earliestPublishMs) ? new Date(earliestPublishMs).toISOString() : "无"}`,
    {
      pageUrl: page.url(),
      context: {
        paginationBodies: paginationBodies.length,
        docBytes: docText.length,
        earliestPublishMs: Number.isFinite(earliestPublishMs) ? earliestPublishMs : null,
      },
    },
  );

  const rscBodies = [docText, ...paginationBodies].filter((body) => body.trim().length > 0);
  const activityIds: string[] = [];
  const seenActivityIds = new Set<string>();
  const rscById = new Map<string, ReturnType<typeof parseRscFeed>[number]>();
  for (const body of rscBodies) {
    const ids = activityIdsFromRsc(body);
    for (const activityId of ids) {
      if (seenActivityIds.has(activityId)) continue;
      seenActivityIds.add(activityId);
      activityIds.push(activityId);
    }
    for (const row of parseRscFeed(body, ids)) {
      const prev = rscById.get(row.activityId);
      if (!prev) {
        rscById.set(row.activityId, row);
        continue;
      }
      rscById.set(row.activityId, {
        ...prev,
        likeCount: maxCount(prev.likeCount, row.likeCount),
        commentCount: maxCount(prev.commentCount, row.commentCount),
        repostCount: maxCount(prev.repostCount, row.repostCount),
      });
    }
  }

  const graphqlById = new Map<string, LinkedInGraphqlCounts>();
  const graphqlPostById = new Map<string, LinkedInGraphqlPost>();
  const graphqlBodies: unknown[] = [...network.bodies];
  for (const text of await readLinkedInGraphqlBodies(page)) {
    try {
      graphqlBodies.push(JSON.parse(text));
    } catch {
      // 非 JSON body 直接跳过
    }
  }
  for (const json of graphqlBodies) {
    try {
      for (const [activityId, counts] of parseLinkedInGraphqlCounts(json)) {
        const prev = graphqlById.get(activityId);
        graphqlById.set(activityId, {
          likes: maxCount(prev?.likes, counts.likes),
          comments: maxCount(prev?.comments, counts.comments),
          shares: maxCount(prev?.shares, counts.shares),
        });
      }
      for (const [activityId, post] of parseLinkedInGraphqlPosts(json)) {
        const prev = graphqlPostById.get(activityId);
        if (!prev || post.text.length > prev.text.length) {
          graphqlPostById.set(activityId, {
            ...post,
            ...(prev
              ? {
                likes: maxCount(prev.likes, post.likes),
                comments: maxCount(prev.comments, post.comments),
                shares: maxCount(prev.shares, post.shares),
              }
              : {}),
          });
        }
      }
    } catch {
      // 单个 GraphQL 响应解析失败不影响其它来源
    }
  }

  const posts = new Map<string, PostRow>();

  // 主来源：RSC 的 activityId + snowflake 时间 + 互动计数。
  for (const rsc of rscById.values()) {
    const publishedTsMs = Date.parse(rsc.publishIso || "");
    if (!Number.isFinite(publishedTsMs) || publishedTsMs < sinceTsMs || publishedTsMs >= untilTsMs) continue;
    posts.set(rsc.activityId, {
      externalId: rsc.activityId,
      url: rsc.url,
      contentType: "post",
      publishedTsMs,
      publishedPrecision: "second",
      title: null,
      text: null,
      metrics: {
        views: null,
        likes: rsc.likeCount,
        comments: rsc.commentCount,
        shares: rsc.repostCount,
        saves: null,
        reads: null,
      },
      raw: { source: "linkedin_rsc", postId: rsc.activityId, url: rsc.url },
    });
  }

  // GraphQL（老页面兜底）：补帖子和正文。
  for (const api of graphqlPostById.values()) {
    if (api.publishedTsMs < sinceTsMs || api.publishedTsMs >= untilTsMs) continue;
    const current = posts.get(api.activityId);
    if (current) {
      if (!current.text && api.text) current.text = api.text;
      if (api.url) current.url = api.url;
      current.raw = { ...(current.raw as object || {}), graphql: { text: api.text, url: api.url } };
    } else {
      posts.set(api.activityId, {
        externalId: api.activityId,
        url: api.url,
        contentType: "post",
        publishedTsMs: api.publishedTsMs,
        publishedPrecision: "second",
        title: null,
        text: api.text,
        metrics: {
          views: null,
          likes: api.likes,
          comments: api.comments,
          shares: api.shares,
          saves: null,
          reads: null,
        },
        raw: { source: "linkedin_graphql", postId: api.activityId, url: api.url, text: api.text },
      });
    }
  }

  // DOM 兜底：只对旧版卡片页生效；新版 sdui 页面没有 data-urn 卡片，通常为空。
  const domCards = await readCards(page);
  for (const card of domCards) {
    const publishedTsMs = activityIdToTsMs(card.activityId);
    if (publishedTsMs == null || publishedTsMs < sinceTsMs || publishedTsMs >= untilTsMs) continue;
    const counts = parseLinkedInCounts(card.labels, card.countsText);
    const current = posts.get(card.activityId);
    if (current) {
      if (!current.text && card.text) current.text = card.text;
      current.metrics.likes = maxCount(current.metrics.likes, counts.likes);
      current.metrics.comments = maxCount(current.metrics.comments, counts.comments);
      current.metrics.shares = maxCount(current.metrics.shares, counts.shares);
      continue;
    }
    posts.set(card.activityId, {
      externalId: card.activityId,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${card.activityId}/`,
      contentType: card.isVideo ? "video" : card.isImage ? "image" : "post",
      publishedTsMs,
      publishedPrecision: "second",
      title: null,
      text: card.text,
      metrics: {
        views: null,
        likes: counts.likes,
        comments: counts.comments,
        shares: counts.shares,
        saves: null,
        reads: null,
      },
      raw: {
        activityId: card.activityId,
        text: card.text,
        countsText: card.countsText,
        labels: card.labels,
      },
    });
  }

  // API 计数优先于 DOM 计数，避免 DOM 文案里的数字污染指标。
  for (const [activityId, counts] of graphqlById) {
    const current = posts.get(activityId);
    if (!current) continue;
    current.metrics.likes = maxCount(current.metrics.likes, counts.likes);
    current.metrics.comments = maxCount(current.metrics.comments, counts.comments);
    current.metrics.shares = maxCount(current.metrics.shares, counts.shares);
  }

  const detectedMode = activityIds.length > 0 ? "rsc" : (graphqlPostById.size > 0 || graphqlById.size > 0) ? "graphql" : "dom";
  const reused = cachedLinkedInMode != null;
  const interfaceMode = cachedLinkedInMode ?? detectedMode;
  cachedLinkedInMode = interfaceMode;
  await log("info", "interface_mode", reused ? `LinkedIn 复用本轮探测：${interfaceMode}` : `LinkedIn 接口探测：${detectedMode}`, {
    pageUrl: page.url(),
    context: {
      rscActivityIds: activityIds.length,
      rscBodies: rscBodies.length,
      paginationBodies: paginationBodies.length,
      docBytes: docText.length,
      graphqlPosts: graphqlPostById.size,
      graphqlCounts: graphqlById.size,
      domCards: domCards.length,
      posts: posts.size,
      httpStatus: navStatus,
      apiResponses: network.stats.apiResponses,
      apiBodies: network.stats.feedResponses,
      apiSampleUrls: network.stats.sampleUrls,
    },
  });

  const parsedAny = activityIds.length > 0 || graphqlPostById.size > 0 || domCards.length > 0;
  if (!parsedAny) {
    const bodyText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 2_000));
    if (/暂无企业快讯|还没有企业快讯|No company updates|No posts yet/i.test(bodyText)) {
      const profile = await readProfile(page);
      await log("info", "no_posts", "LinkedIn 页面显示暂无企业快讯", { pageUrl: page.url() });
      return {
        accountMetrics: {
          followers: parseCount(profile.followersText),
          following: null,
          postsCount: null,
          raw: profile,
        },
        posts: [],
      };
    }
    if (/sign in|join now|加入领英|Join LinkedIn|登录/i.test(bodyText)) {
      throw new Error(`LinkedIn 未登录或需要验证：${account.profileUrl}`);
    }
    if (navStatus === 999) {
      throw new Error(`LinkedIn 返回 HTTP 999（被风控或登录态失效，请重新登录）：${account.profileUrl}`);
    }
    throw new Error(`LinkedIn 没有解析到主页帖子，可能页面改版：${account.profileUrl}`);
  }

  if (rscById.size || graphqlById.size) {
    await log("info", "metrics_sources", `互动数来源：RSC ${rscById.size} 条，GraphQL ${graphqlById.size} 条`, {
      context: { posts: posts.size },
    });
  }

  const profile = await readProfile(page);
  await log("info", "parsed", `窗口内 ${posts.size} 条帖子`, { pageUrl: page.url() });

  return {
    accountMetrics: {
      followers: parseCount(profile.followersText),
      following: null,
      postsCount: null,
      raw: profile,
    },
    posts: [...posts.values()],
  };
}

async function scrapeLinkedIn(ctx: ScrapeContext): Promise<ScrapeResult> {
  let isProbe = await claimModeProbe();
  if (!isProbe && !cachedLinkedInMode) {
    // 前一个 probe 失败了/提前返回且没有缓存，重试一次，避免所有等待者都各自判定。
    isProbe = await claimModeProbe();
  }
  try {
    return await scrapeLinkedInInner(ctx);
  } finally {
    if (isProbe) finishModeProbe();
  }
}

export const linkedinAdapter: PlatformAdapter = {
  code: "linkedin",
  name: "LinkedIn",
  loginUrl: "https://www.linkedin.com/feed/",
  scrapeAccount: scrapeLinkedIn,
};
