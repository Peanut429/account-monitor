import { parseCount } from "../core/time.ts";
import { platformHandleFromUrl, tikHubGet } from "./tikhub.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

function uniqueIdFromAccount(account: { profileUrl: string; handle: string }): string {
  const fromUrl = platformHandleFromUrl(account.profileUrl);
  return (fromUrl || account.handle).replace(/^@/, "");
}

function isPhoto(item: any): boolean {
  return Boolean(item?.image_post_info || item?.imagePostInfo || item?.aweme_type === 2);
}

function itemToPost(item: any, uniqueId: string): PostRow | null {
  const id = String(item?.aweme_id || item?.awemeId || "");
  const seconds = Number(item?.create_time ?? item?.createTime);
  if (!id || !Number.isFinite(seconds) || seconds <= 0) return null;

  const stats = item?.statistics || {};
  const photo = isPhoto(item);
  const author = item?.author || {};
  const handle = String(author.unique_id || uniqueId).replace(/^@/, "");
  const caption = String(item?.desc || "").trim();

  return {
    externalId: id,
    url: `https://www.tiktok.com/@${handle}/${photo ? "photo" : "video"}/${id}`,
    contentType: photo ? "photo" : "video",
    publishedTsMs: seconds * 1000,
    publishedPrecision: "second",
    title: null,
    text: caption,
    metrics: {
      views: parseCount(stats.play_count ?? stats.playCount),
      likes: parseCount(stats.digg_count ?? stats.diggCount),
      comments: parseCount(stats.comment_count ?? stats.commentCount),
      shares: parseCount(stats.share_count ?? stats.shareCount),
      saves: parseCount(stats.collect_count ?? stats.collectCount),
      reads: null,
    },
    raw: {
      aweme_id: id,
      desc: caption,
      create_time: seconds,
      is_top: item?.is_top ?? null,
      play_count: stats.play_count ?? null,
      digg_count: stats.digg_count ?? null,
      comment_count: stats.comment_count ?? null,
      share_count: stats.share_count ?? null,
      collect_count: stats.collect_count ?? null,
    },
  };
}

async function scrapeTikTok({
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  const uniqueId = uniqueIdFromAccount(account);
  if (!uniqueId) throw new Error(`TikTok 无法从主页链接解析用户名：${account.profileUrl}`);

  const idsJson = await tikHubGet(
    "/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username",
    { username: uniqueId },
    "TikTok 用户 ID",
  );
  const secUserId = String(idsJson.data?.sec_user_id || "");
  if (!secUserId) throw new Error(`TikTok 未解析出 sec_user_id：${uniqueId}`);

  let profile: any = null;
  let profileError: string | null = null;
  try {
    const profileJson = await tikHubGet(
      "/api/v1/tiktok/app/v3/handler_user_profile",
      { sec_user_id: secUserId },
      "TikTok 用户资料",
    );
    profile = profileJson.data?.user || null;
  } catch (error: any) {
    profileError = error.message;
    await log("warn", "tiktok_profile_failed", `TikTok 用户资料失败，将从作品作者信息补：${error.message}`);
  }

  const posts = new Map<string, PostRow>();
  let maxCursor = 0;
  let pages = 0;
  let firstAuthor: any = null;

  for (pages = 1; pages <= 10; pages += 1) {
    const json = await tikHubGet(
      "/api/v1/tiktok/app/v3/fetch_user_post_videos",
      { sec_user_id: secUserId, count: 20, max_cursor: maxCursor, sort_type: 0 },
      "TikTok 用户作品",
    );
    const data = json.data || {};
    const items = Array.isArray(data.aweme_list) ? data.aweme_list : [];
    if (!items.length) break;
    if (!firstAuthor) firstAuthor = items[0]?.author || null;

    let pageOldest: number | null = null;
    for (const item of items) {
      const ts = Number(item?.create_time) * 1000;
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (!item?.is_top && (pageOldest == null || ts < pageOldest)) pageOldest = ts;
      if (ts < sinceTsMs || ts >= untilTsMs) continue;
      const post = itemToPost(item, uniqueId);
      if (post && !posts.has(post.externalId)) posts.set(post.externalId, post);
    }

    if (pageOldest != null && pageOldest < sinceTsMs) break;
    if (!data.has_more) break;
    const nextCursor = Number(data.max_cursor);
    if (!Number.isFinite(nextCursor) || nextCursor === maxCursor) break;
    maxCursor = nextCursor;
  }

  if (!profile) {
    if (!firstAuthor) {
      throw new Error(`TikTok 用户资料和作品都拿不到：${profileError || uniqueId}`);
    }
    profile = firstAuthor;
  }

  await log("info", "parsed", `TikTok 窗口内 ${posts.size} 条帖子`, {
    context: { uniqueId, secUserId, pages, profileFallback: Boolean(profileError) },
  });

  return {
    accountMetrics: {
      followers: parseCount(profile?.follower_count),
      following: parseCount(profile?.following_count),
      postsCount: parseCount(profile?.aweme_count),
      raw: {
        uid: profile?.uid ?? null,
        sec_uid: secUserId,
        unique_id: profile?.unique_id || uniqueId,
        nickname: profile?.nickname ?? null,
        follower_count: profile?.follower_count ?? null,
        following_count: profile?.following_count ?? null,
        aweme_count: profile?.aweme_count ?? null,
      },
    },
    posts: [...posts.values()],
  };
}

export const tiktokAdapter: PlatformAdapter = {
  code: "tiktok",
  name: "TikTok",
  loginUrl: "https://www.tiktok.com/",
  needsPage: false,
  scrapeAccount: scrapeTikTok,
};
