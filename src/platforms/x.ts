import { parseCount } from "../core/time.ts";
import { platformHandleFromUrl, tikHubGet } from "./tikhub.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

function screenNameFromAccount(account: { profileUrl: string; handle: string }): string {
  const fromUrl = platformHandleFromUrl(account.profileUrl);
  return (fromUrl || account.handle).replace(/^@/, "");
}

function contentTypeOf(tweet: any): string {
  if (Array.isArray(tweet?.media?.video) && tweet.media.video.length) return "video";
  if (Array.isArray(tweet?.media?.photo) && tweet.media.photo.length) return "photo";
  return "text";
}

function tweetToPost(tweet: any, screenName: string): PostRow | null {
  const id = String(tweet?.tweet_id || "");
  const ts = Date.parse(String(tweet?.created_at || ""));
  if (!id || !Number.isFinite(ts)) return null;

  const text = String(tweet?.text || "").replace(/\s+/g, " ").trim();
  return {
    externalId: id,
    url: `https://x.com/${screenName}/status/${id}`,
    contentType: contentTypeOf(tweet),
    publishedTsMs: ts,
    publishedPrecision: "second",
    title: null,
    text,
    metrics: {
      views: parseCount(tweet?.views),
      likes: parseCount(tweet?.favorites),
      comments: parseCount(tweet?.replies),
      shares: parseCount(tweet?.retweets),
      saves: parseCount(tweet?.bookmarks),
      reads: null,
    },
    raw: {
      tweet_id: id,
      created_at: tweet?.created_at ?? null,
      favorites: tweet?.favorites ?? null,
      replies: tweet?.replies ?? null,
      retweets: tweet?.retweets ?? null,
      quotes: tweet?.quotes ?? null,
      views: tweet?.views ?? null,
      bookmarks: tweet?.bookmarks ?? null,
      text,
    },
  };
}

async function scrapeX({
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  const screenName = screenNameFromAccount(account);
  if (!screenName) throw new Error(`X 无法从主页链接解析用户名：${account.profileUrl}`);

  const profileJson = await tikHubGet(
    "/api/v1/twitter/web/fetch_user_profile",
    { screen_name: screenName },
    "X 用户资料",
  );
  const profile = profileJson.data || {};

  const posts = new Map<string, PostRow>();
  let cursor = "";
  let pages = 0;

  for (pages = 1; pages <= 10; pages += 1) {
    const json = await tikHubGet(
      "/api/v1/twitter/web/fetch_user_post_tweet",
      { screen_name: screenName, cursor },
      "X 用户发帖",
    );
    const data = json.data || {};
    const timeline = Array.isArray(data.timeline) ? data.timeline : [];
    if (!timeline.length) break;

    let pageNewest: number | null = null;
    for (const tweet of timeline) {
      const ts = Date.parse(String(tweet?.created_at || ""));
      if (Number.isFinite(ts) && (pageNewest == null || ts > pageNewest)) pageNewest = ts;
      if (!Number.isFinite(ts) || ts < sinceTsMs || ts >= untilTsMs) continue;
      const post = tweetToPost(tweet, screenName);
      if (post && !posts.has(post.externalId)) posts.set(post.externalId, post);
    }

    if (pageNewest != null && pageNewest < sinceTsMs) break;
    if (!data.next_cursor) break;
    cursor = String(data.next_cursor);
  }

  await log("info", "parsed", `X 窗口内 ${posts.size} 条帖子`, {
    context: { screenName, pages },
  });

  return {
    accountMetrics: {
      followers: parseCount(profile?.sub_count),
      following: parseCount(profile?.friends),
      postsCount: parseCount(profile?.statuses_count),
      raw: {
        rest_id: profile?.rest_id ?? null,
        screen_name: profile?.profile || screenName,
        name: profile?.name ?? null,
        sub_count: profile?.sub_count ?? null,
        friends: profile?.friends ?? null,
        statuses_count: profile?.statuses_count ?? null,
      },
    },
    posts: [...posts.values()],
  };
}

export const xAdapter: PlatformAdapter = {
  code: "x",
  name: "X",
  loginUrl: "https://x.com/home",
  needsPage: false,
  scrapeAccount: scrapeX,
};
