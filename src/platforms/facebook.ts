import type { Page } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

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
  ownerHandle: string;
  ownerUrl: string;
  ownerUrls: string[];
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

function extractPost(story: any): NetworkPost | null {
  const content = story?.comet_sections?.content?.story;
  const publishSeconds = Number(
    story?.creation_time
    ?? story?.comet_sections?.timestamp?.story?.creation_time,
  );
  const url = normalizeContentUrl(content?.wwwURL || content?.url);
  if (!Number.isFinite(publishSeconds) || publishSeconds <= 0 || !url) return null;

  const feedback = story?.comet_sections?.feedback?.story?.story_ufi_container?.story
    ?.feedback_context?.feedback_target_with_context
    ?.comet_ufi_summary_and_actions_renderer?.feedback;

  const actors = Array.isArray(content?.actors) ? content.actors : [];
  const ownerUrls = actors
    .map((actor: any) => normalizeContentUrl(actor?.url))
    .filter(Boolean);

  return {
    url,
    postId: String(content?.post_id || pickPostId(url)),
    publishTsMs: publishSeconds * 1000,
    excerpt: String(content?.message?.text || ""),
    likeText: String(
      feedback?.reaction_count?.count
      ?? feedback?.if_viewer_cannot_see_seen_by_member_list?.reaction_count?.count
      ?? "",
    ),
    commentText: String(
      feedback?.comments_count_summary_renderer?.feedback?.comment_rendering_instance
        ?.comments?.total_count
      ?? "",
    ),
    shareText: String(feedback?.share_count?.count ?? ""),
    playText: String(feedback?.video_view_count_renderer?.feedback?.play_count ?? ""),
    ownerHandle: normalizeHandle(accountFromUrl(ownerUrls[0] || "")),
    ownerUrl: ownerUrls[0] || "",
    ownerUrls,
  };
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

async function scrollTimeline(page: Page): Promise<void> {
  await closeOverlays(page);
  const amount = await page.evaluate(() => Math.max(900, window.innerHeight * 1.8)).catch(() => 1200);
  await page.mouse.wheel(0, amount).catch(async () => {
    await page.evaluate((delta) => window.scrollBy(0, delta), amount).catch(() => {});
  });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(900);
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
    await log("info", "open_profile", `打开 ${account.profileUrl}`, { pageUrl: account.profileUrl });
    await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(4_000);
    await acceptConsent(page);

    if (/\/login\b|\/checkpoint\b|\/recover\b/i.test(page.url())) {
      throw new Error(`Facebook 未登录或需要验证：${account.profileUrl}`);
    }

    let staleRounds = 0;
    for (let round = 0; round < 30; round += 1) {
      const before = collector.stats().posts;
      await scrollTimeline(page);
      const all = collector.list();
      const oldest = all.at(-1)?.publishTsMs;
      const inWindow = all.filter((post) => post.publishTsMs >= sinceTsMs && post.publishTsMs < untilTsMs);
      if (inWindow.length && oldest != null && oldest < sinceTsMs - 24 * 60 * 60 * 1000) break;
      if (collector.stats().posts === before) staleRounds += 1;
      else staleRounds = 0;
      if (staleRounds >= 8) break;
    }

    const stats = collector.stats();
    const all = collector.list();
    const selected = all.filter((post) => post.publishTsMs >= sinceTsMs && post.publishTsMs < untilTsMs);

    if (!all.length) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2_000));
      if (/log in|sign up|登录/i.test(bodyText)) {
        throw new Error(`Facebook 未登录或需要验证：${account.profileUrl}`);
      }
      throw new Error(`Facebook 没有捕获到主页帖子接口，可能页面改版：${account.profileUrl}`);
    }

    const profile = await collectProfile(page);
    const posts = new Map<string, PostRow>();
    for (const post of selected) {
      const externalId = post.postId || post.url;
      if (posts.has(externalId)) continue;
      const contentType = /\/reel\/|\/videos\//i.test(post.url) || post.playText ? "video"
        : /\/photos?\//i.test(post.url) ? "photo"
          : "post";
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
        },
      });
    }

    await log("info", "parsed", `窗口内 ${posts.size} 条帖子（接口响应 ${stats.responses}，Story ${stats.stories}）`, {
      pageUrl: page.url(),
      context: { ...stats, selected: posts.size },
    });

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
