import type { Page, Response } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";
import { activityIdsFromRsc, parseRscFeed } from "./linkedin-rsc-parser.ts";
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

async function readLinkedInCapture(page: Page): Promise<{ rsc: string; graphql: string[] }> {
  return page.evaluate(() => {
    const w = window as any;
    return {
      rsc: Array.isArray(w.__liRscBodies) ? w.__liRscBodies.join("\n") : "",
      graphql: Array.isArray(w.__liGraphqlBodies) ? w.__liGraphqlBodies : [],
    };
  });
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
  // LinkedIn 新版公司动态是 RSC/sdui。DOM 上的点赞数经常不在 social-counts
  // 的按钮文案里，但 RSC 数据里有 ReactionType_* / commentCount / repostCount。
  // 在页面脚本执行前挂 fetch，把 RSC 响应 clone 下来，后面按 activityId 合并。
  await page.addInitScript(() => {
    const w = window as any;
    w.__liRscBodies = [];
    w.__liGraphqlBodies = [];
    const originalFetch = w.fetch.bind(w);
    w.fetch = (...args: any[]) => {
      const input = args[0];
      const url = typeof input === "string" ? input : input?.url || String(input);
      const promise = originalFetch(...args);
      const target = /flagship-web\/(?:feed|rsc-action)/.test(url)
        ? "__liRscBodies"
        : /voyager\/api\/.*graphql/.test(url)
          ? "__liGraphqlBodies"
          : null;
      if (target) {
        promise.then((response: any) => {
          response.clone().text().then((text: string) => {
            w[target].push(text);
            if (w[target].length > 20) w[target].shift();
          }).catch(() => {});
        }).catch(() => {});
      }
      return promise;
    };

    // 少量页面走 XHR，不只 fetch；同样捕获 GraphQL 响应。
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
          const requestUrl = String(this.__liRequestUrl || "");
          const target = /flagship-web\/(?:feed|rsc-action)/.test(requestUrl)
            ? "__liRscBodies"
            : /voyager\/api\/.*graphql/.test(requestUrl)
              ? "__liGraphqlBodies"
              : null;
          if (!target) return;
          try {
            const text = this.responseText;
            if (!text) return;
            w[target].push(text);
            if (w[target].length > 20) w[target].shift();
          } catch {
            // ignore
          }
        });
        return originalSend.apply(this, args);
      };
    }
  });

}

async function readApiPostTimes(
  page: Page,
  extraGraphqlBodies: unknown[] = [],
  extraRscText = "",
): Promise<Array<{ activityId: string; publishedTsMs: number }>> {
  const captured = await readLinkedInCapture(page);
  const out = new Map<string, number>();

  const bodies: unknown[] = [...extraGraphqlBodies];
  for (const text of captured.graphql) {
    try {
      bodies.push(JSON.parse(text));
    } catch {
      // ignore malformed body
    }
  }
  for (const json of bodies) {
    try {
      for (const post of parseLinkedInGraphqlPosts(json).values()) {
        if (post.publishedTsMs > 0) out.set(post.activityId, post.publishedTsMs);
      }
    } catch {
      // ignore malformed body
    }
  }
  try {
    // 首屏文档（sdui SSR）和 fetch 猴补丁抓到的分页 RSC 一起参与边界判断。
    const rscText = `${extraRscText}\n${captured.rsc}`;
    const ids = activityIdsFromRsc(rscText);
    for (const post of parseRscFeed(rscText, ids)) {
      const ts = Date.parse(post.publishIso || "");
      if (Number.isFinite(ts) && ts > 0) out.set(post.activityId, ts);
    }
  } catch {
    // ignore
  }

  return [...out.entries()].map(([activityId, publishedTsMs]) => ({ activityId, publishedTsMs }));
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
  throw new Error(`LinkedIn 打开后未停留在目标公司动态页。目标=${targetUrl} 实际=${page.url() || "空白页"}`);
}

async function scrollLinkedInFeed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("main, main *")]
      .filter((element) => element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 100);
    const primary = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (primary) {
      const maxTop = primary.scrollHeight - primary.clientHeight;
      primary.scrollTop = Math.min(maxTop, primary.scrollTop + Math.max(400, Math.round(primary.clientHeight * 0.8)));
      primary.dispatchEvent(new Event("scroll", { bubbles: true }));
      return;
    }
    window.scrollBy(0, Math.max(900, window.innerHeight * 1.7));
  });
}

async function ensureSortRecent(page: Page): Promise<boolean> {
  // 新版页面用 #sort-dropdown-trigger；旧版是“排序条件”按钮。
  const direct = page.locator("#sort-dropdown-trigger").first();
  const fallback = page.locator('[role="button"]').filter({ hasText: /^排序条件|^Sort by/ }).first();
  const trigger = (await direct.count().catch(() => 0)) ? direct : fallback;
  if (!(await trigger.count().catch(() => 0))) return false;

  const label = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/最新|最近|Recent/i.test(label)) return true;

  await trigger.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1_200);
  const options = page.locator('[role="option"], [role="menuitem"]');
  const count = await options.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!/最近|最新|Recent/i.test(text)) continue;
    await option.click({ force: true }).catch(() => {});
    await page.waitForTimeout(3_000);
    return true;
  }
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function scrapeLinkedInInner({
  page,
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  if (!page) throw new Error("LinkedIn adapter 需要浏览器页面");

  const posts = new Map<string, PostRow>();
  let sawCard = false;

  await log("info", "open_profile", `打开 ${account.profileUrl}`, { pageUrl: account.profileUrl });

  await installLinkedInCapture(page);
  // 必须在 goto 之前挂，否则首屏的 feed GraphQL 响应会漏掉。
  const network = attachLinkedInGraphqlCollector(page);

  const navResponse = await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  // 新版 sdui 页面把公司动态随首屏文档 SSR 下发，不发 feed 请求，所以文档本身就是数据源。
  // 文档里多一层 `\"` 转义，反转义后才能正常抽出帖子编号和互动计数。
  const docText = navResponse ? (await navResponse.text().catch(() => "")).replace(/\\+"/g, "\"") : "";
  await page.waitForTimeout(4_000);

  if (/\/login\b|\/authwall\b|\/checkpoint\b/i.test(page.url())) {
    throw new Error(`LinkedIn 未登录或需要验证：${account.profileUrl}`);
  }
  await ensureOnTargetCompanyPostsPage(page, account.profileUrl);

  const sortedRecent = await ensureSortRecent(page);
  await log("info", "sort_recent", sortedRecent ? "LinkedIn 动态已确认/切换为最近" : "未找到 LinkedIn 排序控件，保持当前排序");

  let staleRounds = 0;
  let consecutiveBeforeRange = 0;
  const boundarySeen = new Set<string>();
  for (let round = 0; ; round += 1) {
    const cards = await readCards(page);
    if (cards.length) sawCard = true;

    let stopForBoundary = false;
    for (const card of cards) {
      const publishedTsMs = activityIdToTsMs(card.activityId);
      if (publishedTsMs == null) continue;

      // 与参考项目一致：连续 3 条早于窗口起点的帖子，停止继续滚动。
      if (!boundarySeen.has(card.activityId)) {
        boundarySeen.add(card.activityId);
        if (publishedTsMs < sinceTsMs) consecutiveBeforeRange += 1;
        else if (publishedTsMs >= untilTsMs) consecutiveBeforeRange = 0;
        else consecutiveBeforeRange = 0;
        if (consecutiveBeforeRange >= 3) {
          await log("info", "linkedin_stop", `连续遇到 ${consecutiveBeforeRange} 条早于 72h 的帖子，停止滚动`, {
            context: { round: round + 1, consecutiveBeforeRange },
          });
          stopForBoundary = true;
          break;
        }
      }

      if (publishedTsMs < sinceTsMs || publishedTsMs >= untilTsMs) continue;
      if (posts.has(card.activityId)) continue;

      const counts = parseLinkedInCounts(card.labels, card.countsText);

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

    // API-only 帖子也可能先于 DOM 卡片出现，同样参与 72h 边界判断。
    for (const api of await readApiPostTimes(page, network.bodies, docText)) {
      if (boundarySeen.has(api.activityId)) continue;
      boundarySeen.add(api.activityId);
      if (api.publishedTsMs < sinceTsMs) consecutiveBeforeRange += 1;
      else consecutiveBeforeRange = 0;
      if (consecutiveBeforeRange >= 3) {
        stopForBoundary = true;
        await log("info", "linkedin_stop", `连续遇到 ${consecutiveBeforeRange} 条早于 72h 的帖子，停止滚动`, {
          context: { round: round + 1, consecutiveBeforeRange, source: "api" },
        });
        break;
      }
    }

    if (stopForBoundary) break;
    const before = posts.size;
    await scrollLinkedInFeed(page);
    await page.waitForTimeout(1_800);
    if (posts.size === before) staleRounds += 1;
    else staleRounds = 0;
    if (staleRounds >= 6) break;
  }

  // 合并 API 里的帖子和互动数；DOM 解析作为兜底。
  const captured = await readLinkedInCapture(page);
  const rscText = `${docText}\n${captured.rsc}`;
  const rscActivityIds = activityIdsFromRsc(rscText);
  const rscById = new Map(
    parseRscFeed(rscText, rscActivityIds).map((row) => [row.activityId, row]),
  );

  const graphqlById = new Map<string, LinkedInGraphqlCounts>();
  const graphqlPostById = new Map<string, LinkedInGraphqlPost>();
  // CDP 收到的 JSON body 已经解析过；猴补丁收到的是文本，这里统一成对象再解析。
  const graphqlBodies: unknown[] = [...network.bodies];
  for (const text of captured.graphql) {
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
          graphqlPostById.set(activityId, { ...post, ...(prev ? { likes: maxCount(prev.likes, post.likes), comments: maxCount(prev.comments, post.comments), shares: maxCount(prev.shares, post.shares) } : {}) });
        }
      }
    } catch {
      // 单个 GraphQL 响应解析失败不影响其它来源
    }
  }

  // API 帖子补进 posts；DOM 已经有同 activityId 时只补正文/URL/指标。
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

  // RSC 帖子补进 posts；RSC 没有正文，正文仍以 DOM/GraphQL 为准。
  for (const rsc of rscById.values()) {
    const publishedTsMs = Date.parse(rsc.publishIso || "");
    if (!Number.isFinite(publishedTsMs) || publishedTsMs < sinceTsMs || publishedTsMs >= untilTsMs) continue;
    if (posts.has(rsc.activityId)) continue;
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

  const detectedMode = rscActivityIds.length > 0 ? "rsc" : (graphqlPostById.size > 0 || graphqlById.size > 0) ? "graphql" : "dom";
  const reused = cachedLinkedInMode != null;
  const interfaceMode = cachedLinkedInMode ?? detectedMode;
  cachedLinkedInMode = interfaceMode;
  await log("info", "interface_mode", reused ? `LinkedIn 复用本轮探测：${interfaceMode}` : `LinkedIn 接口探测：${interfaceMode}`, {
    rscActivityIds: rscActivityIds.length,
    graphqlPosts: graphqlPostById.size,
    posts: posts.size,
    // API 抓取诊断：下次再出问题，直接看这几个数就知道是没抓到响应、还是解析不出来。
    apiResponses: network.stats.apiResponses,
    apiBodies: network.stats.feedResponses,
    rscBodies: captured.rsc.length,
    apiSampleUrls: network.stats.sampleUrls,
  });

  if (!posts.size) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2_000));
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
    if (/sign in|join now|登录/i.test(bodyText)) {
      throw new Error(`LinkedIn 未登录或需要验证：${account.profileUrl}`);
    }
    throw new Error(`LinkedIn 没有解析到主页帖子，可能页面改版：${account.profileUrl}`);
  }

  for (const post of posts.values()) {
    const rsc = rscById.get(post.externalId);
    const gql = graphqlById.get(post.externalId);
    // API 是主来源；DOM 只在 API 缺失时兜底，避免 DOM 文案里的数字污染指标。
    const apiLikes = maxCount(rsc?.likeCount, gql?.likes);
    const apiComments = maxCount(rsc?.commentCount, gql?.comments);
    const apiShares = maxCount(rsc?.repostCount, gql?.shares);
    post.metrics.likes = apiLikes ?? post.metrics.likes;
    post.metrics.comments = apiComments ?? post.metrics.comments;
    post.metrics.shares = apiShares ?? post.metrics.shares;
  }

  if (rscById.size || graphqlById.size) {
    await log("info", "metrics_sources", `互动数来源：RSC ${rscById.size} 条，GraphQL ${graphqlById.size} 条`, {
      posts: posts.size,
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
