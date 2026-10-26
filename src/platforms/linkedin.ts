import type { Page } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";
import { activityIdsFromRsc, parseRscFeed } from "./linkedin-rsc-parser.ts";
import { parseLinkedInGraphqlCounts, type LinkedInGraphqlCounts } from "./linkedin-graphql-parser.ts";

function maxCount(...values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => value != null);
  return nums.length ? Math.max(...nums) : null;
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

    const nodes = document.querySelectorAll('[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"]');
    for (const node of nodes) {
      const raw = node.getAttribute("data-urn") || node.getAttribute("data-id") || "";
      const match = raw.match(/urn:li:activity:(\d+)/);
      if (!match) continue;
      const activityId = match[1];
      if (seen.has(activityId)) continue;
      seen.add(activityId);

      const container = node.closest(".feed-shared-update-v2") || node;
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

async function scrapeLinkedIn({
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

  const navResponse = await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const docText = navResponse ? await navResponse.text().catch(() => "") : "";
  await page.waitForTimeout(4_000);

  if (/\/login\b|\/authwall\b|\/checkpoint\b/i.test(page.url())) {
    throw new Error(`LinkedIn 未登录或需要验证：${account.profileUrl}`);
  }

  let staleRounds = 0;
  for (let round = 0; round < 15; round += 1) {
    const cards = await readCards(page);
    if (cards.length) sawCard = true;

    for (const card of cards) {
      const publishedTsMs = activityIdToTsMs(card.activityId);
      if (publishedTsMs == null || publishedTsMs < sinceTsMs || publishedTsMs >= untilTsMs) continue;
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

    const before = posts.size;
    await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 1.7)));
    await page.waitForTimeout(1_800);
    if (posts.size === before) staleRounds += 1;
    else staleRounds = 0;
    if (staleRounds >= 6) break;
  }

  if (!sawCard) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2_000));
    if (/sign in|join now|登录/i.test(bodyText)) {
      throw new Error(`LinkedIn 未登录或需要验证：${account.profileUrl}`);
    }
    throw new Error(`LinkedIn 没有解析到主页帖子，可能页面改版：${account.profileUrl}`);
  }

  // 合并 RSC 里的互动数；DOM 解析作为兜底。
  const captured = await page.evaluate(() => {
    const w = window as any;
    return {
      rsc: Array.isArray(w.__liRscBodies) ? w.__liRscBodies.join("\n") : "",
      graphql: Array.isArray(w.__liGraphqlBodies) ? w.__liGraphqlBodies : [],
    };
  });

  const rscById = new Map(
    parseRscFeed(`${docText}\n${captured.rsc}`, [...posts.keys()]).map((row) => [row.activityId, row]),
  );

  const graphqlById = new Map<string, LinkedInGraphqlCounts>();
  for (const text of captured.graphql) {
    try {
      for (const [activityId, counts] of parseLinkedInGraphqlCounts(JSON.parse(text))) {
        const prev = graphqlById.get(activityId);
        graphqlById.set(activityId, {
          likes: maxCount(prev?.likes, counts.likes),
          comments: maxCount(prev?.comments, counts.comments),
          shares: maxCount(prev?.shares, counts.shares),
        });
      }
    } catch {
      // 单个 GraphQL 响应解析失败不影响其它来源
    }
  }

  const rscActivityIds = activityIdsFromRsc(`${docText}\n${captured.rsc}`).length;
  const interfaceMode = rscActivityIds > 0 ? "rsc" : graphqlById.size > 0 ? "graphql" : "dom";
  await log("info", "interface_mode", `LinkedIn 接口探测：${interfaceMode}`, {
    rscActivityIds,
    graphqlPosts: graphqlById.size,
    posts: posts.size,
  });

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

export const linkedinAdapter: PlatformAdapter = {
  code: "linkedin",
  name: "LinkedIn",
  loginUrl: "https://www.linkedin.com/feed/",
  scrapeAccount: scrapeLinkedIn,
};
