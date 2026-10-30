import type { Page } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";
import { nextFacebookDateBoundaryState, shouldStopFacebookDateBoundary } from "./facebook-network-stop.ts";

const GRAPHQL_RE = /facebook\.com\/api\/graphql(?:\/|\?|$)/i;

type NetworkPost = {
  url: string;
  postId: string;
  publishTsMs: number;
  excerpt: string;
  likeText: string;
  commentText: string;
  shareText: string;
  playText: string;
  /** 该帖的 UFI 结构类型，见 extractUfiCounts：classic | adaptive | dom | none */
  ufiFormat: string;
  ownerHandle: string;
  ownerUrl: string;
  ownerUrls: string[];
  isPinned: boolean;
  contentType: string;
  relativeTimeText: string;
  domPlayText: string;
  domLikeText: string;
  domCommentText: string;
  domShareText: string;
};

type DomPost = {
  url: string;
  timeText: string;
  exactTimeText: string;
  text: string;
  type: string;
  isPinned: boolean;
  playText: string;
  likeText: string;
  commentText: string;
  shareText: string;
};

function normalizeHandle(value: unknown): string {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function accountFromUrl(input: unknown): string {
  try {
    const parts = new URL(String(input || "")).pathname.split("/").filter(Boolean);
    if (parts[0] === "profile.php") return "profile.php";
    return parts[0] || "";
  } catch {
    return "";
  }
}

function normalizeContentUrl(input: unknown): string {
  const text = String(input || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, "https://www.facebook.com");
    if (!/facebook\.com$/i.test(url.hostname)) return "";
    if (/\/photo(\.php)?\/?$/i.test(url.pathname) && url.searchParams.get("fbid")) {
      return `${url.origin}${url.pathname}?fbid=${url.searchParams.get("fbid")}`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function pickPostId(value: unknown): string {
  const text = String(value || "");
  for (const pattern of [
    /\/posts\/([^/?#\s]+)/i,
    /\/reel\/(\d+)/i,
    /\/videos\/(\d+)/i,
    /story_fbid[=:](\d+)/i,
    /fbid=(\d+)/i,
    /pcb\.(\d+)/i,
  ]) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return "";
}

function parseJsonLine(line: string): any | null {
  const text = String(line || "").trim();
  if (!text) return null;
  for (const candidate of [text, text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;?/, "").trim()]) {
    if (!candidate || (candidate[0] !== "{" && candidate[0] !== "[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Facebook 会混入非 JSON 行
    }
  }
  return null;
}

function collectStoryObjects(parsed: any): any[] {
  const out: any[] = [];
  const seen = new Set<any>();

  function push(story: any): void {
    if (!story || typeof story !== "object" || seen.has(story)) return;
    seen.add(story);
    if (story.__typename === "Story" || (story.creation_time && story.comet_sections)) out.push(story);
  }

  // 参考项目的稳定形态：data.node / data.node.timeline_list_feed_units
  const data = parsed?.data;
  if (data && typeof data === "object") {
    if (Array.isArray(data)) {
      for (const item of data) push(item?.node);
    } else {
      const node = data.node;
      // 只有真正的 Story 才标记为 seen；容器节点留给下面的递归兜底。
      if (node?.__typename === "Story" || (node?.creation_time && node?.comet_sections)) push(node);
      const edges = node?.timeline_list_feed_units?.edges;
      if (Array.isArray(edges)) for (const edge of edges) push(edge?.node);
    }
  }

  // 兜底：有些响应是嵌套结构，递归找 Story，避免漏掉。
  const stack: any[] = [parsed];
  let steps = 0;
  while (stack.length && steps < 20000) {
    steps += 1;
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (node.__typename === "Story" && (node.creation_time || node.comet_sections)) {
      out.push(node);
      continue;
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return out;
}

function pickCount(...values: unknown[]): unknown {
  for (const value of values) if (value != null) return value;
  return undefined;
}

function adaptiveRendererFeedback(feedback: any, typename: string): any {
  const renderers = Array.isArray(feedback?.adaptive_ufi_action_renderers)
    ? feedback.adaptive_ufi_action_renderers
    : [];
  for (const renderer of renderers) {
    if (String(renderer?.__typename || "") === typename) return renderer?.feedback ?? null;
  }
  return null;
}

/**
 * 主页 feed 有两类返回结构，是账号维度上的长期差异（目前只有自己的账号能看到播放量，
 * 其他账号一律返回另一套），所以两类要同时解析，不是等 Facebook 修好的临时兼容。
 *
 * - classic：`DefaultCometUFISummaryAndActionsRenderer`
 *   赞/评论/转发直接挂在 summary feedback 上，播放量在
 *   `video_view_count_renderer.feedback.play_count`。
 * - adaptive：`DefaultModernCometUFISummaryAndActionsRenderer`
 *   计数搬进 `adaptive_ufi_action_renderers[]`，按 __typename 分辨赞/评论/转发；
 *   这一类整份响应里没有播放量字段（`story.view_count` 恒为 null），views 只能是 null。
 *   注意 `media.loop_count` 是预览循环次数，不是播放量，别当兜底。
 *
 * classic 里 adaptive_ufi_action_renderers 也在，但 feedback 只有 id、没有计数，
 * 所以按 classic → adaptive 的顺序取值不会读到错值。
 */
function extractUfiCounts(feedback: any, targetWithContext: any): {
  likeText: string;
  commentText: string;
  shareText: string;
  /** 只有 classic 类型拿得到，adaptive 类型恒为空串 */
  playText: string;
  ufiFormat: string;
} {
  const flatLike = feedback?.reaction_count?.count
    ?? feedback?.if_viewer_cannot_see_seen_by_member_list?.reaction_count?.count;
  const flatComment = feedback?.comments_count_summary_renderer?.feedback
    ?.comment_rendering_instance?.comments?.total_count;
  const flatShare = feedback?.share_count?.count;
  const flatPlay = feedback?.video_view_count_renderer?.feedback?.play_count;

  const reactFeedback = adaptiveRendererFeedback(feedback, "UFIStoryReactActionRenderer");
  const commentFeedback = adaptiveRendererFeedback(feedback, "UFICommentActionRenderer");
  const shareFeedback = adaptiveRendererFeedback(feedback, "XFBUFIAdaptiveShareActionRenderer");

  const like = pickCount(flatLike, reactFeedback?.reaction_count?.count);
  const comment = pickCount(
    flatComment,
    commentFeedback?.comment_rendering_instance?.comments?.total_count,
    targetWithContext?.comment_rendering_instance?.comments?.total_count,
  );
  const share = pickCount(flatShare, shareFeedback?.share_count?.count);

  const usedClassic = flatLike != null || flatComment != null || flatShare != null;
  const ufiFormat = usedClassic ? "classic" : like != null || comment != null || share != null ? "adaptive" : "none";

  return {
    likeText: String(like ?? ""),
    commentText: String(comment ?? ""),
    shareText: String(share ?? ""),
    playText: String(flatPlay ?? ""),
    ufiFormat,
  };
}

function extractPost(story: any): NetworkPost | null {
  const content = story?.comet_sections?.content?.story;
  const publishSeconds = Number(
    story?.creation_time
    ?? story?.comet_sections?.timestamp?.story?.creation_time,
  );
  const url = normalizeContentUrl(content?.wwwURL || content?.url);
  if (!Number.isFinite(publishSeconds) || publishSeconds <= 0 || !url) return null;

  const targetWithContext = story?.comet_sections?.feedback?.story?.story_ufi_container?.story
    ?.feedback_context?.feedback_target_with_context;
  const feedback = targetWithContext?.comet_ufi_summary_and_actions_renderer?.feedback;
  const counts = extractUfiCounts(feedback, targetWithContext);

  const actors = Array.isArray(content?.actors) ? content.actors : [];
  const ownerUrls = actors
    .map((actor: any) => normalizeContentUrl(actor?.url))
    .filter(Boolean);

  return {
    url,
    postId: String(content?.post_id || pickPostId(url)),
    publishTsMs: publishSeconds * 1000,
    excerpt: String(content?.message?.text || ""),
    likeText: counts.likeText,
    commentText: counts.commentText,
    shareText: counts.shareText,
    playText: counts.playText,
    ufiFormat: counts.ufiFormat,
    ownerHandle: normalizeHandle(accountFromUrl(ownerUrls[0] || "")),
    ownerUrl: ownerUrls[0] || "",
    ownerUrls,
    isPinned: false,
    contentType: /\/reel\/|\/videos\//i.test(url) ? "video" : /\/photos?\//i.test(url) ? "photo" : "post",
    relativeTimeText: "",
    domPlayText: "",
    domLikeText: "",
    domCommentText: "",
    domShareText: "",
  };
}

function parseDomTime(text: string, base = Date.now()): number | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const clean = raw.replace(/[·•]/g, " ").replace(/\s+/g, " ").trim();

  const zhDate = clean.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2}))?/i);
  if (zhDate) {
    const now = new Date(base);
    let year = zhDate[1] ? Number(zhDate[1]) : now.getFullYear();
    const month = Number(zhDate[2]);
    const day = Number(zhDate[3]);
    let hour = Number(zhDate[5] || 0);
    const minute = Number(zhDate[6] || 0);
    if (/下午|PM/i.test(zhDate[4] || "") && hour < 12) hour += 12;
    if (/上午|AM/i.test(zhDate[4] || "") && hour === 12) hour = 0;
    let ts = new Date(year, month - 1, day, hour, minute).getTime();
    if (!zhDate[1] && Number.isFinite(ts) && ts > base + 24 * 60 * 60 * 1000) {
      year -= 1;
      ts = new Date(year, month - 1, day, hour, minute).getTime();
    }
    return Number.isFinite(ts) ? ts : null;
  }

  const amount = Number((clean.match(/(\d+(?:\.\d+)?)/) || [])[1] || 1);
  const relativeMs =
    /(刚刚|just now)/i.test(clean) ? 0 :
    /(秒|sec|second|seconds|s\b)/i.test(clean) ? amount * 1000 :
    /(分钟|分|min|minute|minutes|m\b)/i.test(clean) ? amount * 60 * 1000 :
    /(小时|时|hour|hours|h\b)/i.test(clean) ? amount * 60 * 60 * 1000 :
    /(天|day|days|d\b)/i.test(clean) ? amount * 24 * 60 * 60 * 1000 :
    /(周|星期|week|weeks|w\b)/i.test(clean) ? amount * 7 * 24 * 60 * 60 * 1000 :
    /(个月|月前|month|months|mo\b)/i.test(clean) ? amount * 30 * 24 * 60 * 60 * 1000 :
    /(年|year|years|yr\b)/i.test(clean) ? amount * 365 * 24 * 60 * 60 * 1000 :
    NaN;
  if (Number.isFinite(relativeMs)) return base - relativeMs;

  const absolute = Date.parse(clean.replace(/\bat\b/i, " "));
  return Number.isFinite(absolute) ? absolute : null;
}

function domToNetworkPost(dom: DomPost, accountHandle: string): NetworkPost | null {
  const publishedTsMs = parseDomTime(dom.exactTimeText || dom.timeText);
  if (publishedTsMs == null) return null;
  return {
    url: dom.url,
    postId: pickPostId(dom.url),
    publishTsMs: publishedTsMs,
    excerpt: dom.text,
    likeText: dom.likeText,
    commentText: dom.commentText,
    shareText: dom.shareText,
    playText: dom.playText,
    ufiFormat: "dom",
    ownerHandle: normalizeHandle(accountHandle),
    ownerUrl: "",
    ownerUrls: [],
    isPinned: dom.isPinned,
    contentType: dom.type,
    relativeTimeText: dom.timeText,
    domPlayText: dom.playText,
    domLikeText: dom.likeText,
    domCommentText: dom.commentText,
    domShareText: dom.shareText,
  };
}

async function readDomPosts(page: Page, enrichTooltips = false): Promise<DomPost[]> {
  const posts = await page.evaluate(() => {
    const norm = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeUrl = (href: string) => {
      try {
        const url = new URL(href, location.href);
        if (!/facebook\.com/i.test(url.hostname)) return "";
        if (/\/photo(\.php)?\/?$/i.test(url.pathname) && url.searchParams.get("fbid")) {
          return `${url.origin}${url.pathname}?fbid=${url.searchParams.get("fbid")}`;
        }
        return `${url.origin}${url.pathname}`;
      } catch {
        return "";
      }
    };
    const pickMetric = (text: string, patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match?.[1]) return match[1].replace(/,/g, "").trim();
      }
      return "";
    };
    const headingY = Math.min(
      ...([...document.querySelectorAll("h2, h3, span, div")]
        .filter((el) => /^(帖子|Posts)$/.test(norm(el.innerText || el.textContent || "")))
        .map((el) => el.getBoundingClientRect().top + window.scrollY)
        .filter((y) => Number.isFinite(y))),
      Number.POSITIVE_INFINITY,
    );
    const cards = [...document.querySelectorAll('[data-pagelet*="TimelineFeedUnit"]')];
    const posts: DomPost[] = [];
    for (const card of cards) {
      const text = norm(card.innerText || card.textContent || "");
      if (text.length < 20) continue;
      const links = [...card.querySelectorAll("a[href]")].map((a) => ({
        href: a.href,
        text: norm(a.innerText || a.textContent || ""),
        aria: norm(a.getAttribute("aria-label") || ""),
      }));
      const isContent = (href: string) => /\/posts\/|\/reel\/|\/videos\/|story_fbid|permalink|photo\.php|\/photo\//i.test(href);
      const isComment = (href: string) => /[?&](?:comment_id|reply_comment_id)=/i.test(href);
      const timeLink = links.find((a) => isContent(a.href) && !isComment(a.href)
        && /(\d{1,2}[:：]\d{2}|(\d{4}年)?\d{1,2}月\d{1,2}日|\d+\s*(?:秒|分钟|分|小时|时|天|周|星期|个月|月前|年)|刚刚|just now|yesterday|\d+\s*(?:s|m|h|d|w)\b|[A-Z][a-z]{2,8}\s+\d{1,2})/i.test(`${a.text} ${a.aria}`));
      const contentLink = timeLink || links.find((a) => isContent(a.href) && !isComment(a.href));
      const url = contentLink ? normalizeUrl(contentLink.href) : "";
      if (!url) continue;
      const labels = [...card.querySelectorAll("[aria-label]")].map((el) => norm(el.getAttribute("aria-label") || ""));
      const allText = `${text} ${labels.join(" ")}`;
      posts.push({
        url,
        timeText: contentLink ? (contentLink.aria || contentLink.text) : "",
        exactTimeText: "",
        text,
        type: /\/reel\/|\/videos\//i.test(url) || card.querySelector("video") ? "video"
          : /\/photos?\//i.test(url) ? "photo" : "post",
        isPinned: /(^|\s)(精选|置顶|Pinned|Featured)(\s|$)/i.test(text)
          || (Number.isFinite(headingY) && card.getBoundingClientRect().top + window.scrollY < headingY),
        playText: pickMetric(allText, [/([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:次)?\s*(?:播放|views?)/i]),
        likeText: pickMetric(allText, [
          /所有心情：\s*([\d.,]+\s*[KMBkmb万千亿]?)/i,
          /([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:likes?|人赞|位用户)/i,
        ]),
        commentText: pickMetric(allText, [/([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:条)?\s*(?:评论|comments?)/i]),
        shareText: pickMetric(allText, [/([\d.,]+\s*[KMBkmb万千亿]?)\s*(?:次)?\s*(?:分享|shares?)/i]),
      });
    }
    return posts;
  });
  // 之前这里漏了 return：`return posts` 写在 page.evaluate 的回调里，函数本身返回 undefined，
  // 于是每轮滚动都在 domPosts.map 处抛 "Cannot read properties of undefined (reading 'map')"。
  // 另外页面若在求值过程中跳转也会拿到 undefined，一并兜底成空数组。
  return Array.isArray(posts) ? posts : [];
}

function createNetworkCollector(page: Page) {
  const posts = new Map<string, NetworkPost>();
  let responseCount = 0;
  let storyCount = 0;

  function preferText(current: string, incoming: string): string {
    return String(incoming || "").trim().length > String(current || "").trim().length ? incoming : current;
  }

  function remember(row: NetworkPost): void {
    const key = row.postId || row.url;
    if (!key) return;
    const current = posts.get(key);
    if (!current) {
      posts.set(key, row);
      return;
    }
    posts.set(key, {
      ...current,
      ...row,
      excerpt: preferText(current.excerpt, row.excerpt),
      likeText: row.likeText || current.likeText,
      commentText: row.commentText || current.commentText,
      shareText: row.shareText || current.shareText,
      playText: row.playText || current.playText,
      ufiFormat: row.ufiFormat !== "none" ? row.ufiFormat : current.ufiFormat,
      ownerUrls: [...new Set([...current.ownerUrls, ...row.ownerUrls])],
    });
  }

  async function onResponse(response: any): Promise<void> {
    if (!GRAPHQL_RE.test(response.url())) return;
    let text = "";
    try {
      text = await response.text();
    } catch {
      return;
    }
    responseCount += 1;
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseJsonLine(line);
      if (!parsed) continue;
      for (const story of collectStoryObjects(parsed)) {
        storyCount += 1;
        const post = extractPost(story);
        if (post) remember(post);
      }
    }
  }

  page.on("response", onResponse);
  return {
    list(): NetworkPost[] {
      return [...posts.values()].sort((a, b) => b.publishTsMs - a.publishTsMs);
    },
    stats(): { posts: number; responses: number; stories: number } {
      return { posts: posts.size, responses: responseCount, stories: storyCount };
    },
    dispose(): void {
      page.off("response", onResponse);
    },
  };
}

async function collectProfile(page: Page): Promise<{
  name: string;
  followersText: string;
  followingText: string;
  pageUrl: string;
}> {
  return page.evaluate(() => {
    const norm = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
    const main = document.querySelector('[role="main"], main') || document.body;
    const body = norm((main as HTMLElement)?.innerText || main.textContent);
    const pick = (label: string) => {
      const before = new RegExp(`([\\d.,]+\\s*[KMBkmb万千亿]?)\\s*(?:位|人)?\\s*(?:${label})`, "i").exec(body);
      if (before) return before[1].trim();
      const after = new RegExp(`(?:${label})\\s*([\\d.,]+\\s*[KMBkmb万千亿]?)`, "i").exec(body);
      return after ? after[1].trim() : "";
    };
    return {
      name: norm(document.querySelector("h1")?.textContent),
      followersText: pick("粉丝|followers"),
      followingText: pick("关注|following"),
      pageUrl: location.href,
    };
  });
}

async function acceptConsent(page: Page): Promise<void> {
  for (const pattern of [/Allow all|Accept all/i, /同意|接受/i]) {
    const button = page.getByRole("button", { name: pattern }).first();
    if (await button.count().catch(() => 0)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }
}

/**
 * 首屏 0 条帖子时重新加载页面的最大重试次数（不含首次加载）。
 * 参考项目是 3 次；这里单账号有 MONITOR_ACCOUNT_TIMEOUT_MS（默认 300s）上限，
 * 一次失败尝试约 40-60s，取 2 次（最多 3 次加载）留出滚动抓取的时间。
 */
const FIRST_SCREEN_MAX_RETRIES = 2;
/** 单次加载等首屏帖子卡片的时间。 */
const FIRST_SCREEN_WAIT_MS = 20_000;
/** 首屏等待 + 重载的总时间预算，避免把 MONITOR_ACCOUNT_TIMEOUT_MS 全部耗在重试上。 */
const FIRST_SCREEN_RETRY_BUDGET_MS = 180_000;
/** 预算不足这么多时间就不再发起下一次重载，避免刚重载就被单账号超时打断。 */
const FIRST_SCREEN_RETRY_RESERVE_MS = 30_000;

async function waitForStablePosts(
  page: Page,
  { timeoutMs = 30_000, minPosts = 1, stableMs = 1_600 } = {},
): Promise<{ count: number; maxCount: number; timedOut: boolean }> {
  const start = Date.now();
  let lastCount = -1;
  let maxCount = 0;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await page.evaluate(() => document.querySelectorAll('[data-pagelet*="TimelineFeedUnit"]').length).catch(() => 0);
    maxCount = Math.max(maxCount, count);
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    }
    if (count >= minPosts && Date.now() - stableSince >= stableMs) {
      return { count, maxCount, timedOut: false };
    }
    await page.waitForTimeout(500);
  }
  return { count: lastCount, maxCount, timedOut: true };
}

async function waitForFacebookReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await page.waitForFunction(() => {
    const body = document.body?.innerText || "";
    const hasMain = !!document.querySelector('[role="main"], main');
    const hasFeed = !!document.querySelector('[data-pagelet*="TimelineFeedUnit"], [role="article"]');
    const loginShell = /登录 Facebook|Facebook 登录|Log into Facebook|Log in to Facebook|Sign up for Facebook|注册 Facebook/i.test(body);
    return hasMain && !loginShell && (hasFeed || /粉丝|followers|关注|following/i.test(body));
  }, null, { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 12_000) }).catch(() => {});
}

/**
 * Facebook 的 feed 请求超时后，右栏会停在骨架屏，底部显示“用时超出预期”（英文界面
 * “This is taking longer than expected”）。此时 DOM 里一张帖子卡片都没有，
 * 后续滚动永远拿不到帖子，只能整页重载重试。
 */
const STALLED_FEED_SOURCE = "用时超出预期|用时较长|花的时间比预期|taking longer than expected|took longer than expected";

type FirstScreenState = { cards: number; stalled: boolean; timedOut: boolean };

async function readFirstScreen(page: Page): Promise<{ cards: number; stalled: boolean }> {
  return page.evaluate((pattern: string) => {
    const body = document.body?.innerText || "";
    return {
      cards: document.querySelectorAll('[data-pagelet*="TimelineFeedUnit"]').length,
      stalled: new RegExp(pattern, "i").test(body),
    };
  }, STALLED_FEED_SOURCE).catch(() => ({ cards: 0, stalled: false }));
}

/**
 * 等首屏帖子卡片出现。
 * - 卡片出现：再等卡片数量稳定（和原来 waitForStablePosts 一致），返回 timedOut=false。
 * - 页面自己报了“用时超出预期”且又等了 8 秒还没有卡片：判定首屏卡死，提前返回等待重试。
 * - 一直没卡片也没提示：等到超时，返回 timedOut=true。
 */
async function waitForFirstScreen(page: Page, timeoutMs = FIRST_SCREEN_WAIT_MS): Promise<FirstScreenState> {
  const start = Date.now();
  let stalledSince = 0;
  while (Date.now() - start < timeoutMs) {
    const state = await readFirstScreen(page);
    if (state.cards > 0) {
      await waitForStablePosts(page, { timeoutMs: 10_000, minPosts: 1 }).catch(() => null);
      return { cards: state.cards, stalled: false, timedOut: false };
    }
    if (state.stalled) {
      if (!stalledSince) stalledSince = Date.now();
      if (Date.now() - stalledSince >= 8_000) return { cards: 0, stalled: true, timedOut: false };
    } else {
      stalledSince = 0;
    }
    await page.waitForTimeout(500);
  }
  return { cards: 0, stalled: stalledSince > 0, timedOut: true };
}

async function assertLoggedIn(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const loginForm = !!document.querySelector('input[name="email"], input[name="pass"], form[action*="/login"]');
    const loginGate = /登录 Facebook|Facebook 登录|Log into Facebook|Log in to Facebook|Sign up for Facebook|注册 Facebook/i.test(body);
    const loggedInNav = !!document.querySelector('a[href*="/friends"], a[href*="/notifications"], [aria-label*="账户"], [aria-label*="Account"]');
    return { loginForm, loginGate, loggedInNav, sample: body.split("\n").slice(0, 14).join(" / ") };
  });
  if ((state.loginForm || state.loginGate) && !state.loggedInNav) {
    throw new Error(`Facebook 未登录或需要验证，请先运行 pnpm run login --platform facebook。页面状态：${state.sample}`);
  }
}

async function closeOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hasOverlay = await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter(visible);
      return dialogs.length > 0;
    }).catch(() => false);
    if (!hasOverlay) return;
    const clicked = await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      for (const root of [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter(visible)) {
        for (const control of [...root.querySelectorAll("button, [role='button'], [aria-label]")].filter(visible)) {
          const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""} ${control.textContent || ""}`.trim();
          if (/^(关闭|Close|Dismiss|关闭菜单|关闭对话框)$/i.test(label)) {
            (control as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);
    if (!clicked) await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function scrollTimeline(page: Page): Promise<{
  before: { y: number; h: number };
  after: { y: number; h: number };
}> {
  await closeOverlays(page);
  const before = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight })).catch(() => ({ y: 0, h: 0 }));
  const amount = await page.evaluate(() => Math.max(900, window.innerHeight * 1.8)).catch(() => 1200);
  await page.mouse.wheel(0, amount).catch(async () => {
    await page.evaluate((delta) => window.scrollBy(0, delta), amount).catch(() => {});
  });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(900);
  let after = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight })).catch(() => before);

  if (after.y === before.y && after.h === before.h) {
    await closeOverlays(page);
    await page.mouse.wheel(0, amount).catch(async () => {
      await page.evaluate((delta) => window.scrollBy(0, delta), amount).catch(() => {});
    });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    after = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight })).catch(() => before);
  }
  if (after.y === before.y && after.h === before.h) {
    await page.keyboard.press("PageDown").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    after = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight })).catch(() => before);
  }
  return { before, after };
}

async function reloadProfile(page: Page, profileUrl: string, hard: boolean): Promise<void> {
  if (hard) {
    // 软 reload 会复用已经卡死的前端状态，第二次起先跳 about:blank 再重新打开，强制重拉首屏。
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  } else {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  }
  await page.waitForTimeout(1_500);
}

async function scrapeFacebook({
  page,
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  if (!page) throw new Error("Facebook adapter 需要浏览器页面");
  const collector = createNetworkCollector(page);

  try {
    const maxFirstScreenRetries = Math.max(0, Number(
      process.env.FACEBOOK_FIRST_SCREEN_RETRIES || FIRST_SCREEN_MAX_RETRIES,
    ));
    const retryBudgetMs = Math.max(0, Number(
      process.env.FACEBOOK_FIRST_SCREEN_RETRY_BUDGET_MS || FIRST_SCREEN_RETRY_BUDGET_MS,
    ));
    const retryDeadline = Date.now() + retryBudgetMs;

    const openProfile = async (): Promise<FirstScreenState> => {
      await acceptConsent(page);
      await waitForFacebookReady(page, 30_000);
      await assertLoggedIn(page);
      if (/\/login\b|\/checkpoint\b|\/recover\b/i.test(page.url())) {
        throw new Error(`Facebook 未登录或需要验证：${account.profileUrl}`);
      }
      return waitForFirstScreen(page, FIRST_SCREEN_WAIT_MS);
    };

    await log("info", "open_profile", `打开 ${account.profileUrl}`, { pageUrl: account.profileUrl });
    await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2_000);

    let firstScreen = await openProfile();
    let firstScreenRetries = 0;

    // 首屏 0 帖子（最典型的是骨架屏 + “用时超出预期”）时整页重载重试；
    // 只要接口已经抓到了帖子就继续走滚动，不再重载。
    while (
      firstScreen.cards === 0
      && collector.stats().posts === 0
      && firstScreenRetries < maxFirstScreenRetries
      && Date.now() + FIRST_SCREEN_RETRY_RESERVE_MS < retryDeadline
    ) {
      firstScreenRetries += 1;
      const reason = firstScreen.stalled
        ? "页面停在骨架屏并提示“用时超出预期”"
        : `等待 ${Math.round(FIRST_SCREEN_WAIT_MS / 1000)} 秒仍没有帖子卡片`;
      await log(
        "warn",
        "facebook_retry",
        `首屏没有加载出帖子（${reason}），第 ${firstScreenRetries}/${maxFirstScreenRetries} 次重新加载：${account.profileUrl}`,
        {
          pageUrl: page.url(),
          context: {
            retry: firstScreenRetries,
            maxRetries: maxFirstScreenRetries,
            stalled: firstScreen.stalled,
            timedOut: firstScreen.timedOut,
          },
        },
      );
      await page.waitForTimeout(1_500 * firstScreenRetries);
      try {
        await reloadProfile(page, account.profileUrl, firstScreenRetries >= 2);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await log("warn", "facebook_retry_nav_failed", `第 ${firstScreenRetries} 次重载失败：${message}`, {
          pageUrl: page.url(),
        });
      }
      firstScreen = await openProfile();
    }

    if (firstScreenRetries > 0 && (firstScreen.cards > 0 || collector.stats().posts > 0)) {
      await log(
        "info",
        "facebook_retry_ok",
        `第 ${firstScreenRetries} 次重载后首屏恢复（卡片 ${firstScreen.cards}，接口帖子 ${collector.stats().posts}）`,
        { pageUrl: page.url() },
      );
    }

    if (
      firstScreen.cards === 0
      && collector.stats().posts === 0
      && (firstScreen.stalled || firstScreen.timedOut)
    ) {
      const bodySample = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400))
        .catch(() => "");
      const stalledNote = firstScreen.stalled ? "，页面提示“用时超出预期”" : "";
      const retryNote = firstScreenRetries > 0
        ? `，重载 ${firstScreenRetries}/${maxFirstScreenRetries} 次仍为空`
        : "，未重载";
      throw new Error(
        `Facebook 首屏没有加载出帖子（FACEBOOK_FIRST_SCREEN_TIMEOUT）：${account.profileUrl}`
        + `，候选卡片=0${stalledNote}${retryNote}。页面文本：${bodySample}`,
      );
    }

    // 与参考项目 facebook-network.ts 的 scrapeContent 保持一致：
    // 连续遇到 3 条早于窗口起点的非置顶帖子，判定已越过 72h 边界，立即停止滚动。
    const seen = new Set<string>();
    let seenInsideRange = false;
    let consecutiveBeforeRange = 0;
    let stableRounds = 0;
    let lastSeenCount = 0;
    let bottomConfirmations = 0;
    let shouldStop = false;

    for (let scrollRound = 0; ; scrollRound += 1) {
      await closeOverlays(page);
      await page.waitForTimeout(500);
      const domPosts = await readDomPosts(page);
      const domByUrl = new Map(domPosts.map((post) => [normalizeContentUrl(post.url).toLowerCase(), post]));
      const visiblePosts = collector.list();
      let addedThisRound = 0;

      for (const post of visiblePosts) {
        const key = post.postId || post.url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        addedThisRound += 1;

        const position = post.publishTsMs < sinceTsMs
          ? "before"
          : post.publishTsMs >= untilTsMs
            ? "after"
            : "inside";
        const dateBoundaryState = nextFacebookDateBoundaryState(
          { seenInsideRange, consecutiveBeforeRange },
          { position, isPinned: domByUrl.get(normalizeContentUrl(post.url).toLowerCase())?.isPinned ?? post.isPinned },
        );
        seenInsideRange = dateBoundaryState.seenInsideRange;
        consecutiveBeforeRange = dateBoundaryState.consecutiveBeforeRange;

        if (shouldStopFacebookDateBoundary({
          sinceTime: sinceTsMs,
          stopAfterBeforeRange: 3,
          seenInsideRange,
          consecutiveBeforeRange,
        })) {
          shouldStop = true;
          await log("info", "facebook_stop", `连续遇到 ${consecutiveBeforeRange} 条早于 72h 的帖子，停止滚动`, {
            context: { scrollRound: scrollRound + 1, consecutiveBeforeRange, seenInsideRange },
          });
          break;
        }
      }

      if (shouldStop) break;
      if (seen.size === lastSeenCount || addedThisRound === 0) stableRounds += 1;
      else stableRounds = 0;
      lastSeenCount = seen.size;

      if (stableRounds >= 6) {
        if (bottomConfirmations >= 3) {
          await log("info", "facebook_stop", "连续 6 轮无新增且底部确认 3 次，停止滚动", {
            context: { scrollRound: scrollRound + 1, bottomConfirmations },
          });
          break;
        }
        stableRounds = 0;
      }

      const { before, after } = await scrollTimeline(page);
      if (after.y === before.y && after.h === before.h) {
        stableRounds += 1;
        bottomConfirmations += 1;
        await page.waitForTimeout(1200);
      } else {
        bottomConfirmations = 0;
      }
    }

    const stats = collector.stats();
    const all = collector.list();
    const finalDomPosts = await readDomPosts(page, true);
    const finalDomByUrl = new Map(finalDomPosts.map((post) => [normalizeContentUrl(post.url).toLowerCase(), post]));

    // 参考项目是 network + DOM 合并：即使接口有部分数据，DOM 独有帖子也要补进来。
    const networkKeys = new Set(
      all.flatMap((post) => [
        normalizeContentUrl(post.url).toLowerCase(),
        String(post.postId || "").toLowerCase(),
      ]).filter(Boolean),
    );
    for (const dom of finalDomPosts) {
      const key = normalizeContentUrl(dom.url).toLowerCase();
      if (!key || networkKeys.has(key) || networkKeys.has(String(pickPostId(dom.url)).toLowerCase())) continue;
      const post = domToNetworkPost(dom, account.handle);
      if (!post) continue;
      networkKeys.add(key);
      all.push(post);
    }

    for (const post of all) {
      const dom = finalDomByUrl.get(normalizeContentUrl(post.url).toLowerCase());
      if (!dom) continue;
      post.isPinned = post.isPinned || dom.isPinned;
      post.relativeTimeText = post.relativeTimeText || dom.timeText;
      post.contentType = dom.type || post.contentType;
      post.likeText = post.likeText || dom.likeText;
      post.commentText = post.commentText || dom.commentText;
      post.shareText = post.shareText || dom.shareText;
      post.playText = post.playText || dom.playText;
    }

    const selected = all.filter((post) => post.publishTsMs >= sinceTsMs && post.publishTsMs < untilTsMs);

    if (!all.length) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2_000));
      if (/log in|sign up|登录/i.test(bodyText)) {
        throw new Error(`Facebook 未登录或需要验证：${account.profileUrl}`);
      }
      const cardCount = await page.evaluate(() => document.querySelectorAll('[data-pagelet*="TimelineFeedUnit"]').length).catch(() => 0);
      const code = cardCount > 0 ? "FACEBOOK_FIRST_SCREEN_PARSE_EMPTY" : "FACEBOOK_FIRST_SCREEN_TIMEOUT";
      throw new Error(`Facebook 首屏解析 0 条帖子（${code}）：${account.profileUrl}，候选卡片=${cardCount}`);
    }

    const profile = await collectProfile(page);
    const posts = new Map<string, PostRow>();
    const formats = new Map<string, number>();
    for (const post of selected) {
      const externalId = post.postId || post.url;
      if (posts.has(externalId)) continue;
      const contentType = post.contentType || (/\/reel\/|\/videos\//i.test(post.url) || post.playText ? "video"
        : /\/photos?\//i.test(post.url) ? "photo"
          : "post");
      posts.set(externalId, {
        externalId,
        url: post.url,
        contentType,
        publishedTsMs: post.publishTsMs,
        publishedPrecision: "second",
        title: null,
        text: post.excerpt,
        metrics: {
          views: parseCount(post.playText),
          likes: parseCount(post.likeText),
          comments: parseCount(post.commentText),
          shares: parseCount(post.shareText),
          saves: null,
          reads: null,
        },
        raw: {
          source: "facebook_graphql",
          postId: post.postId,
          ownerHandle: post.ownerHandle,
          ownerUrl: post.ownerUrl,
          ownerUrls: post.ownerUrls,
          likeText: post.likeText,
          commentText: post.commentText,
          shareText: post.shareText,
          playText: post.playText,
          ufiFormat: post.ufiFormat,
        },
      });
      formats.set(post.ufiFormat, (formats.get(post.ufiFormat) || 0) + 1);
    }

    const rows = [...posts.values()];
    const playMissing = rows.filter((post) => post.metrics.views == null).length;
    const formatText = [...formats].map(([key, value]) => `${key}=${value}`).join(" ") || "none";
    await log(
      "info",
      "parsed",
      `窗口内 ${rows.length} 条帖子（接口响应 ${stats.responses}，Story ${stats.stories}，`
      + `结构 ${formatText}，无播放量 ${playMissing}）`,
      {
        pageUrl: page.url(),
        context: { ...stats, selected: rows.length, playMissing, ufiFormats: Object.fromEntries(formats) },
      },
    );

    return {
      accountMetrics: {
        followers: parseCount(profile.followersText),
        following: parseCount(profile.followingText),
        postsCount: null,
        raw: profile,
      },
      posts: [...posts.values()],
    };
  } finally {
    collector.dispose();
  }
}

export const facebookAdapter: PlatformAdapter = {
  code: "facebook",
  name: "Facebook",
  loginUrl: "https://www.facebook.com/",
  scrapeAccount: scrapeFacebook,
};

// 仅供 scripts/probe-facebook-parse.ts 做抓包 fixture 回归，生产路径只走 scrapeFacebook。
export { collectStoryObjects, extractPost, parseJsonLine, readDomPosts };
