import type { Page, Response } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

const GRAPHQL_RE = /\/api\/graphql\b/;

function collectStories(value: any, out: any[], seen: Set<any>, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 24 || seen.has(value)) return;
  seen.add(value);

  if (value.__typename === "Story" && (value.creation_time || value.comet_sections)) {
    out.push(value);
  }
  for (const child of Object.values(value)) {
    collectStories(child, out, seen, depth + 1);
  }
}

function parseGraphQLText(text: string): any[] {
  const stories: any[] = [];
  const seen = new Set<any>();

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("for (;;);")) line = line.slice("for (;;);".length).trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      collectStories(JSON.parse(line), stories, seen);
    } catch {
      // 单行不是完整 JSON 时跳过；Facebook 的响应里会混入非 JSON 行。
    }
  }
  return stories;
}

function normalizeFacebookUrl(raw: unknown): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("/")) return `https://www.facebook.com${text}`;
  return "";
}

function contentTypeOf(url: string, playText: string): string {
  if (/\/videos?\//i.test(url) || /\/reel\//i.test(url) || playText) return "video";
  if (/\/photos?\//i.test(url)) return "photo";
  return "post";
}

function storyToPost(story: any): PostRow | null {
  const content = story?.comet_sections?.content?.story || {};
  const publishSeconds = Number(
    story?.creation_time
    ?? story?.comet_sections?.timestamp?.story?.creation_time,
  );
  const url = normalizeFacebookUrl(content?.wwwURL || content?.url);
  if (!Number.isFinite(publishSeconds) || publishSeconds <= 0 || !url) return null;

  const feedback = story?.comet_sections?.feedback?.story?.story_ufi_container?.story
    ?.feedback_context?.feedback_target_with_context
    ?.comet_ufi_summary_and_actions_renderer?.feedback;

  const likeText = String(
    feedback?.reaction_count?.count
    ?? feedback?.if_viewer_cannot_see_seen_by_member_list?.reaction_count?.count
    ?? "",
  );
  const shareText = String(feedback?.share_count?.count ?? "");
  const commentText = String(
    feedback?.comments_count_summary_renderer?.feedback?.comment_rendering_instance
      ?.comments?.total_count
    ?? "",
  );
  const playText = String(
    feedback?.video_view_count_renderer?.feedback?.play_count ?? "",
  );

  const externalId = String(content?.post_id || url);
  const text = String(content?.message?.text || "");
  const contentType = contentTypeOf(url, playText);

  return {
    externalId,
    url,
    contentType,
    publishedTsMs: publishSeconds * 1000,
    publishedPrecision: "second",
    title: null,
    text,
    metrics: {
      views: parseCount(playText),
      likes: parseCount(likeText),
      comments: parseCount(commentText),
      shares: parseCount(shareText),
      saves: null,
      reads: null,
    },
    raw: {
      postId: content?.post_id || null,
      creationTime: publishSeconds,
      url,
      text,
      likeText,
      commentText,
      shareText,
      playText,
    },
  };
}

async function readProfile(page: Page): Promise<{
  name: string;
  followersText: string;
  followingText: string;
  pageUrl: string;
}> {
  return page.evaluate(() => {
    const text = (element: Element | null) => (element?.textContent || "").replace(/\s+/g, " ").trim();
    const body = document.body.innerText;
    return {
      name: text(document.querySelector("h1")),
      followersText: /([\d.,]+\s*[KMB]?)\s*followers?/i.exec(body)?.[1] || "",
      followingText: /([\d.,]+\s*[KMB]?)\s*following/i.exec(body)?.[1] || "",
      pageUrl: location.href,
    };
  });
}

async function acceptConsent(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /Allow all|Accept all|同意|接受/i }).first();
  if (await button.count().catch(() => 0)) {
    await button.click().catch(() => {});
    await page.waitForTimeout(800);
  }
}

async function scrapeFacebook({
  page,
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  if (!page) throw new Error("Facebook adapter 需要浏览器页面");

  const posts = new Map<string, PostRow>();
  let storyCount = 0;
  let responseCount = 0;

  const handler = async (response: Response) => {
    if (!GRAPHQL_RE.test(response.url())) return;
    let text: string;
    try {
      text = await response.text();
    } catch {
      return;
    }
    responseCount += 1;
    const stories = parseGraphQLText(text);
    for (const story of stories) {
      storyCount += 1;
      const post = storyToPost(story);
      if (!post || post.publishedTsMs == null) continue;
      if (post.publishedTsMs < sinceTsMs || post.publishedTsMs >= untilTsMs) continue;
      if (!posts.has(post.externalId)) posts.set(post.externalId, post);
    }
  };

  page.on("response", handler);
  try {
    await log("info", "open_profile", `打开 ${account.profileUrl}`, { pageUrl: account.profileUrl });
    await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(3_000);
    await acceptConsent(page);

    let staleRounds = 0;
    for (let round = 0; round < 15; round += 1) {
      const before = posts.size;
      await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 1.7)));
      await page.waitForTimeout(1_800);
      if (posts.size === before) staleRounds += 1;
      else staleRounds = 0;
      if (staleRounds >= 6) break;
    }

    if (responseCount === 0 || storyCount === 0) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2_000));
      if (/log in|sign up|登录/i.test(bodyText)) {
        throw new Error(`Facebook 未登录或需要验证：${account.profileUrl}`);
      }
      throw new Error(`Facebook 没有捕获到主页帖子接口，可能页面改版：${account.profileUrl}`);
    }

    const profile = await readProfile(page);
    await log("info", "parsed", `窗口内 ${posts.size} 条帖子（页面共解析 ${storyCount} 条）`, {
      pageUrl: page.url(),
      context: { responseCount, storyCount },
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
    page.off("response", handler);
  }
}

export const facebookAdapter: PlatformAdapter = {
  code: "facebook",
  name: "Facebook",
  loginUrl: "https://www.facebook.com/",
  scrapeAccount: scrapeFacebook,
};
