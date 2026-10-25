import { parseCount } from "../core/time.ts";
import { tikHubGet } from "./tikhub.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

function channelIdFromUrl(profileUrl: string): string {
  const match = profileUrl.match(/\/channel\/(UC[\w-]{20,})/);
  return match ? match[1] : "";
}

async function resolveChannelId(profileUrl: string): Promise<string> {
  const direct = channelIdFromUrl(profileUrl);
  if (direct) return direct;
  const json = await tikHubGet(
    "/api/v1/youtube/web_v2/get_channel_id",
    { channel_url: profileUrl },
    "YouTube 频道 ID",
  );
  const id = String(json.data?.channel_id || "");
  if (!id) throw new Error(`YouTube 未解析出 channel_id：${profileUrl}`);
  return id;
}

async function fetchVideoInfo(videoId: string): Promise<any> {
  try {
    const json = await tikHubGet(
      "/api/v1/youtube/web_v2/get_video_info",
      { video_id: videoId },
      "YouTube 视频详情",
    );
    const data = json.data || {};
    if (data.publish_date || data.upload_date) return data;
    throw new Error("YouTube 视频详情缺少发布时间");
  } catch (primary: any) {
    try {
      const json = await tikHubGet(
        "/api/v1/youtube/web_v2/get_video_info_v2",
        { video_id: videoId },
        "YouTube 视频详情 v2",
      );
      const data = json.data || {};
      if (!data.publish_date && !data.upload_date) throw new Error("缺少发布时间");
      return data;
    } catch (fallback: any) {
      throw new Error(`YouTube 视频 ${videoId} 详情失败：v1=${primary.message}；v2=${fallback.message}`);
    }
  }
}

function videoToPost(info: any, videoId: string, contentType: "video" | "short"): PostRow | null {
  const dateText = info?.publish_date || info?.upload_date || "";
  const ts = Date.parse(String(dateText));
  if (!videoId || !Number.isFinite(ts)) return null;

  return {
    externalId: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    contentType,
    publishedTsMs: ts,
    publishedPrecision: "second",
    title: info?.title || null,
    text: info?.description || null,
    metrics: {
      views: parseCount(info?.view_count),
      likes: parseCount(info?.like_count),
      comments: parseCount(info?.comment_count),
      shares: null,
      saves: null,
      reads: null,
    },
    raw: {
      video_id: videoId,
      title: info?.title ?? null,
      publish_date: info?.publish_date ?? null,
      upload_date: info?.upload_date ?? null,
      view_count: info?.view_count ?? null,
      like_count: info?.like_count ?? null,
      comment_count: info?.comment_count ?? null,
    },
  };
}

async function collectVideos({
  channelId,
  sinceTsMs,
  untilTsMs,
  contentType,
  listPath,
  log,
}: {
  channelId: string;
  sinceTsMs: number;
  untilTsMs: number;
  contentType: "video" | "short";
  listPath: string;
  log: ScrapeContext["log"];
}): Promise<PostRow[]> {
  const posts = new Map<string, PostRow>();
  let continuationToken = "";
  let olderStreak = 0;

  for (let page = 0; page < 3; page += 1) {
    const json = await tikHubGet(
      listPath,
      {
        channel_id: channelId,
        need_format: true,
        continuation_token: continuationToken,
      },
      contentType === "short" ? "YouTube 频道 Shorts" : "YouTube 频道视频",
    );
    const data = json.data || {};
    const items = contentType === "short"
      ? (Array.isArray(data.shorts) ? data.shorts : [])
      : (Array.isArray(data.videos) ? data.videos : []);
    if (!items.length) break;

    for (const item of items) {
      const videoId = String(item?.video_id || "");
      if (!videoId || posts.has(videoId)) continue;
      const info = await fetchVideoInfo(videoId);
      const post = videoToPost(info, videoId, contentType);
      if (!post || post.publishedTsMs == null) continue;

      if (post.publishedTsMs < sinceTsMs) {
        olderStreak += 1;
        if (olderStreak >= 2) break;
        continue;
      }
      if (post.publishedTsMs >= untilTsMs) continue;

      olderStreak = 0;
      posts.set(videoId, post);
    }

    if (olderStreak >= 2) break;
    if (!data.continuation_token) break;
    continuationToken = String(data.continuation_token);
  }

  await log("info", "list_done", `YouTube ${contentType} 窗口内 ${posts.size} 条`, {
    context: { channelId, contentType },
  });
  return [...posts.values()];
}

async function scrapeYouTube({
  account,
  sinceTsMs,
  untilTsMs,
  log,
}: ScrapeContext): Promise<ScrapeResult> {
  const channelId = await resolveChannelId(account.profileUrl);

  const descriptionJson = await tikHubGet(
    "/api/v1/youtube/web_v2/get_channel_description",
    { channel_id: channelId },
    "YouTube 频道信息",
  );
  const profile = descriptionJson.data || {};

  const videos = await collectVideos({
    channelId,
    sinceTsMs,
    untilTsMs,
    contentType: "video",
    listPath: "/api/v1/youtube/web_v2/get_channel_videos",
    log,
  });
  const shorts = await collectVideos({
    channelId,
    sinceTsMs,
    untilTsMs,
    contentType: "short",
    listPath: "/api/v1/youtube/web_v2/get_channel_shorts",
    log,
  });

  const posts = new Map<string, PostRow>();
  for (const post of [...videos, ...shorts]) posts.set(post.externalId, post);

  await log("info", "parsed", `YouTube 窗口内 ${posts.size} 条（视频 ${videos.length}，Shorts ${shorts.length}）`, {
    context: { channelId },
  });

  return {
    accountMetrics: {
      followers: parseCount(profile?.subscriber_count),
      following: null,
      postsCount: parseCount(profile?.video_count),
      raw: {
        channel_id: channelId,
        title: profile?.title ?? null,
        handle: profile?.handle ?? null,
        subscriber_count: profile?.subscriber_count ?? null,
        video_count: profile?.video_count ?? null,
      },
    },
    posts: [...posts.values()],
  };
}

export const youtubeAdapter: PlatformAdapter = {
  code: "youtube",
  name: "YouTube",
  loginUrl: "https://www.youtube.com/",
  needsPage: false,
  scrapeAccount: scrapeYouTube,
};
