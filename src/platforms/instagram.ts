import { parseCount } from "../core/time.ts";
import { platformHandleFromUrl, tikHubGet } from "./tikhub.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

type IgMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
};

function usernameFromAccount(account: { profileUrl: string; handle: string }): string {
  const fromUrl = platformHandleFromUrl(account.profileUrl);
  return (fromUrl || account.handle).replace(/^@/, "").replace(/\/+$/, "");
}

function isPinned(item: any, userId: string): boolean {
  const pinned = item?.timeline_pinned_user_ids;
  return Array.isArray(pinned) && pinned.map(String).includes(String(userId));
}

function takenAtMs(item: any): number | null {
  const seconds = Number(item?.taken_at);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function itemMetrics(item: any): IgMetrics {
  return {
    views: parseCount(item?.play_count ?? item?.ig_play_count ?? item?.view_count ?? item?.video_view_count),
    likes: parseCount(item?.like_count ?? item?.edge_media_preview_like?.count),
    comments: parseCount(
      item?.comment_count
      ?? item?.edge_media_to_parent_comment?.count
      ?? item?.edge_media_to_comment?.count,
    ),
    shares: parseCount(item?.media_repost_count ?? item?.reshare_count ?? item?.share_count),
    saves: parseCount(item?.save_count),
  };
}

function hasAnyMetric(metrics: IgMetrics): boolean {
  return metrics.views != null || metrics.likes != null || metrics.comments != null;
}

function isVideoItem(item: any): boolean {
  return Number(item?.media_type) === 2 || item?.product_type === "clips";
}

function postFromItem(item: any, userId: string): PostRow | null {
  const code = String(item?.code || item?.shortcode || "").trim();
  const ts = takenAtMs(item);
  if (!code || ts == null) return null;

  const video = isVideoItem(item);
  const metrics = itemMetrics(item);
  const caption = String(item?.caption?.text || item?.caption_text || "");

  return {
    externalId: code,
    url: video
      ? `https://www.instagram.com/reel/${code}/`
      : `https://www.instagram.com/p/${code}/`,
    contentType: video ? "reel" : Number(item?.media_type) === 8 ? "carousel" : "post",
    publishedTsMs: ts,
    publishedPrecision: "second",
    title: null,
    text: caption,
    metrics: {
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      saves: metrics.saves,
      reads: null,
    },
    raw: {
      code,
      taken_at: Number(item?.taken_at),
      media_type: item?.media_type ?? null,
      product_type: item?.product_type ?? null,
      like_count: item?.like_count ?? null,
      comment_count: item?.comment_count ?? null,
      play_count: item?.play_count ?? null,
      save_count: item?.save_count ?? null,
      media_repost_count: item?.media_repost_count ?? null,
      reshare_count: item?.reshare_count ?? null,
    },
  };
}

async function fetchUserInfo(username: string): Promise<any> {
  try {
    const json = await tikHubGet(
      "/api/v1/instagram/v1/fetch_user_info_by_username_v3",
      { username },
      "Instagram 用户信息 v3",
    );
    return json.data || {};
  } catch (primary: any) {
    try {
      const json = await tikHubGet(
        "/api/v1/instagram/v2/fetch_user_info",
        { username },
        "Instagram 用户信息 v2",
      );
      return json.data?.data || json.data || {};
    } catch (fallback: any) {
      throw new Error(`Instagram 用户信息失败：v3=${primary.message}；v2=${fallback.message}`);
    }
  }
}

function oldestNonPinned(items: any[], userId: string): number | null {
  let oldest: number | null = null;
  for (const item of items) {
    if (isPinned(item, userId)) continue;
    const ts = takenAtMs(item);
    if (ts == null) continue;
    if (oldest == null || ts < oldest) oldest = ts;
  }
  return oldest;
}

async function fetchPostsV1(userId: string, sinceTsMs: number): Promise<any[]> {
  const items: any[] = [];
  let maxId = "";

  for (let page = 0; page < 10; page += 1) {
    const json = await tikHubGet(
      "/api/v1/instagram/v1/fetch_user_posts",
      { user_id: userId, count: 50, max_id: maxId },
      "Instagram 帖子列表 v1",
    );
    const data = json.data || {};
    const pageItems = Array.isArray(data.items) ? data.items : [];
    if (!pageItems.length) break;
    if (page === 0 && !pageItems.some((item) => takenAtMs(item) != null)) {
      throw new Error("Instagram v1 帖子列表缺少 taken_at");
    }
    items.push(...pageItems);
    const oldest = oldestNonPinned(pageItems, userId);
    if (oldest != null && oldest < sinceTsMs) break;
    if (!data.more_available || !data.next_max_id) break;
    maxId = String(data.next_max_id);
  }

  return items;
}

async function fetchPostsV2(username: string, userId: string, sinceTsMs: number): Promise<any[]> {
  const items: any[] = [];
  let paginationToken = "";

  for (let page = 0; page < 10; page += 1) {
    const json = await tikHubGet(
      "/api/v1/instagram/v2/fetch_user_posts",
      { username, pagination_token: paginationToken },
      "Instagram 帖子列表 v2",
    );
    const data = json.data || {};
    const pageItems = Array.isArray(data.data?.items) ? data.data.items : [];
    if (!pageItems.length) break;
    items.push(...pageItems);
    const oldest = oldestNonPinned(pageItems, userId);
    if (oldest != null && oldest < sinceTsMs) break;
    if (!data.pagination_token) break;
    paginationToken = String(data.pagination_token);
  }

  return items;
}

async function fetchPostMetricsFallback(code: string, url: string): Promise<IgMetrics | null> {
  try {
    const json = await tikHubGet(
      "/api/v1/instagram/v2/fetch_post_info",
      { code_or_url: code },
      "Instagram 帖子详情 v2",
    );
    const data = json.data || {};
    const metrics = data.metrics || data.data?.metrics || {};
    if (metrics && (metrics.like_count != null || metrics.play_count != null || metrics.comment_count != null)) {
      return {
        views: parseCount(metrics.play_count),
        likes: parseCount(metrics.like_count),
        comments: parseCount(metrics.comment_count),
        shares: parseCount(metrics.repost_count),
        saves: parseCount(metrics.save_count),
      };
    }
  } catch {
    // 继续尝试 v1
  }

  try {
    const json = await tikHubGet(
      "/api/v1/instagram/v1/fetch_post_by_url",
      { post_url: url },
      "Instagram 帖子详情 v1",
    );
    const data = json.data || {};
    return {
      views: parseCount(data.video_view_count ?? data.play_count ?? data.video_play_count),
      likes: parseCount(data.edge_media_preview_like?.count ?? data.like_count),
      comments: parseCount(
        data.edge_media_to_parent_comment?.count
        ?? data.edge_media_to_comment?.count
        ?? data.comment_count,
      ),
      shares: parseCount(data.reshare_count),
      saves: parseCount(data.save_count),
    };
  } catch {
    return null;
  }
}

async function scrapeInstagram({
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  const username = usernameFromAccount(account);
  const info = await fetchUserInfo(username);
  const userId = String(info?.pk || info?.id || "");
  if (!userId) throw new Error(`Instagram 用户信息缺少 pk/id：${username}`);

  let items: any[];
  let listSource = "v1";
  try {
    items = await fetchPostsV1(userId, sinceTsMs);
  } catch (primary: any) {
    await log("warn", "instagram_list_fallback", `v1 帖子列表失败，降级 v2：${primary.message}`);
    listSource = "v2";
    items = await fetchPostsV2(username, userId, sinceTsMs);
  }

  const posts = new Map<string, PostRow>();
  let fallbackCount = 0;

  for (const item of items) {
    const ts = takenAtMs(item);
    if (ts == null || ts < sinceTsMs || ts >= untilTsMs) continue;
    let post = postFromItem(item, userId);
    if (!post) continue;

    if (!hasAnyMetric(post.metrics as IgMetrics)) {
      const metrics = await fetchPostMetricsFallback(post.externalId, post.url);
      if (metrics) {
        post = {
          ...post,
          metrics: {
            views: metrics.views,
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
            saves: metrics.saves,
            reads: null,
          },
        };
        fallbackCount += 1;
      } else {
        await log("warn", "instagram_post_metrics_missing", `帖子 ${post.externalId} 列表和详情都没拿到指标`, {
          context: { url: post.url },
        });
      }
    }

    if (!posts.has(post.externalId)) posts.set(post.externalId, post);
  }

  await log("info", "parsed", `Instagram 窗口内 ${posts.size} 条（列表 ${listSource}，详情降级 ${fallbackCount} 条）`, {
    context: { username, userId, listSource, fallbackCount },
  });

  return {
    accountMetrics: {
      followers: parseCount(info?.follower_count),
      following: parseCount(info?.following_count),
      postsCount: parseCount(info?.media_count),
      raw: {
        pk: userId,
        username: info?.username || username,
        full_name: info?.full_name || null,
        follower_count: info?.follower_count ?? null,
        following_count: info?.following_count ?? null,
        media_count: info?.media_count ?? null,
      },
    },
    posts: [...posts.values()],
  };
}

export const instagramAdapter: PlatformAdapter = {
  code: "instagram",
  name: "Instagram",
  loginUrl: "https://www.instagram.com/",
  needsPage: false,
  scrapeAccount: scrapeInstagram,
};
