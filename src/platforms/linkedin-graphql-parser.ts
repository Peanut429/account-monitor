/**
 * LinkedIn 旧版 GraphQL（voyager/api/graphql）互动数解析。
 *
 * LinkedIn 会在 RSC / GraphQL 两套接口之间切换，所以 RSC 解析之外必须保留
 * GraphQL 兜底。这里只抽取 activityId -> { likes, comments, shares }，
 * 不依赖帖子正文，正文仍以 DOM 为准。
 */

type JsonObject = Record<string, any>;

function parseActivityId(urn: unknown): string {
  const match = String(urn || "").match(/activity:(\d+)/);
  return match ? match[1] : "";
}

function parseActivityUrn(value: unknown): string {
  const match = String(value || "").match(/urn:li:activity:\d+/);
  return match ? match[0] : "";
}

function parseShareUrn(value: unknown): string {
  const match = String(value || "").match(/urn:li:(?:ugcPost|share):\d+/);
  return match ? match[0] : "";
}

function buildUrnLookupKeys(...values: unknown[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    if (text.startsWith("urn:")) keys.add(text);
    const activityUrn = parseActivityUrn(text);
    if (activityUrn) keys.add(activityUrn);
    const shareUrn = parseShareUrn(text);
    if (shareUrn) keys.add(shareUrn);
  }
  return [...keys];
}

function setLookupValue(map: Map<string, JsonObject>, keys: string[], value: JsonObject): void {
  for (const key of keys) {
    if (key) map.set(key, value);
  }
}

function getLookupValue(map: Map<string, JsonObject>, keys: string[]): JsonObject | null {
  for (const key of keys) {
    if (!key) continue;
    const value = map.get(key);
    if (value) return value;
  }
  return null;
}

function findFeedRoot(value: unknown, seen = new WeakSet<object>()): JsonObject | null {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value as object)) return null;
  seen.add(value as object);

  const node = value as JsonObject;
  if (
    (Array.isArray(node["*elements"]) && node["*elements"].length)
    || (Array.isArray(node.elements) && node.elements.length)
  ) {
    return node;
  }

  for (const [key, child] of Object.entries(node)) {
    if (!child || typeof child !== "object") continue;
    if (
      (/organizationalpage/i.test(key) || /feed/i.test(key))
      && (Array.isArray((child as JsonObject)["*elements"]) || Array.isArray((child as JsonObject).elements))
    ) {
      return child as JsonObject;
    }
    const nested = findFeedRoot(child, seen);
    if (nested) return nested;
  }
  return null;
}

function findIncludedArray(value: unknown, seen = new WeakSet<object>()): JsonObject[] {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value as object)) return [];
  seen.add(value as object);

  const node = value as JsonObject;
  if (Array.isArray(node.included)) return node.included as JsonObject[];

  for (const child of Object.values(node)) {
    if (!child || typeof child !== "object") continue;
    const nested = findIncludedArray(child, seen);
    if (nested.length) return nested;
  }
  return [];
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export type LinkedInGraphqlCounts = {
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export function parseLinkedInGraphqlCounts(json: unknown): Map<string, LinkedInGraphqlCounts> {
  const out = new Map<string, LinkedInGraphqlCounts>();
  const feedData = findFeedRoot(json);
  if (!feedData) return out;

  const elements = (feedData["*elements"] || feedData.elements || []) as unknown[];
  const included = findIncludedArray(json);

  const includedByEntityUrn = new Map<string, JsonObject>();
  const updateByKey = new Map<string, JsonObject>();
  const socialDetailByKey = new Map<string, JsonObject>();
  const activityCountsByKey = new Map<string, JsonObject>();

  for (const item of included) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.$type || "");
    if (item.entityUrn) includedByEntityUrn.set(String(item.entityUrn), item);

    if (type === "com.linkedin.voyager.dash.feed.Update") {
      setLookupValue(updateByKey, buildUrnLookupKeys(
        item.entityUrn,
        item.preDashEntityUrn,
        item.metadata?.backendUrn,
        item.metadata?.shareUrn,
        item.socialContent?.shareUrl,
      ), item);
    } else if (type === "com.linkedin.voyager.dash.social.SocialDetail") {
      setLookupValue(socialDetailByKey, buildUrnLookupKeys(
        item.entityUrn,
        item.preDashEntityUrn,
        item.threadUrn,
        item["*totalSocialActivityCounts"],
      ), item);
    } else if (type === "com.linkedin.voyager.dash.feed.SocialActivityCounts") {
      setLookupValue(activityCountsByKey, buildUrnLookupKeys(
        item.urn,
        item.entityUrn,
        item.preDashEntityUrn,
      ), item);
    }
  }

  for (const elementUrn of elements) {
    const activityId = parseActivityId(elementUrn);
    if (!activityId) continue;

    const elementKeys = buildUrnLookupKeys(elementUrn, `urn:li:activity:${activityId}`);
    const update = includedByEntityUrn.get(String(elementUrn)) || getLookupValue(updateByKey, elementKeys);
    if (!update) continue;

    const socialDetailEntityUrn = update["*socialDetail"];
    const socialDetail = (socialDetailEntityUrn && includedByEntityUrn.get(String(socialDetailEntityUrn)))
      || getLookupValue(socialDetailByKey, buildUrnLookupKeys(socialDetailEntityUrn));

    const totalSocialActivityCountsEntityUrn = socialDetail?.["*totalSocialActivityCounts"];
    const directCounts = totalSocialActivityCountsEntityUrn
      ? includedByEntityUrn.get(String(totalSocialActivityCountsEntityUrn))
      : null;

    const countLookupKeys = buildUrnLookupKeys(
      elementUrn,
      `urn:li:activity:${activityId}`,
      update.metadata?.backendUrn,
      update.metadata?.shareUrn,
      update.entityUrn,
      update.preDashEntityUrn,
      update.socialContent?.shareUrl,
      socialDetail?.entityUrn,
      socialDetail?.preDashEntityUrn,
      socialDetail?.threadUrn,
      socialDetail?.["*totalSocialActivityCounts"],
    );
    const counts = directCounts || getLookupValue(activityCountsByKey, countLookupKeys) || {};

    const likes = numberOrNull(counts.numLikes);
    const comments = numberOrNull(counts.numComments);
    const shares = numberOrNull(counts.numShares);
    if (likes != null || comments != null || shares != null) {
      out.set(activityId, { likes, comments, shares });
    }
  }

  return out;
}


function extractLinkedInText(value: unknown, seen = new WeakSet<object>()): string {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value !== "object") return "";
  if (seen.has(value as object)) return "";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => extractLinkedInText(item, seen)).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }
  const node = value as JsonObject;
  for (const key of ["text", "plainText", "value", "title", "name"]) {
    const text = extractLinkedInText(node[key], seen);
    if (text) return text;
  }
  for (const [key, child] of Object.entries(node)) {
    if (!/(text|comment|caption|title|headline|description|name|value)/i.test(key)) continue;
    const text = extractLinkedInText(child, seen);
    if (text) return text;
  }
  return "";
}

export type LinkedInGraphqlPost = {
  activityId: string;
  url: string;
  publishedTsMs: number;
  text: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

function activityIdToTsMs(activityId: string): number {
  try {
    return Number(BigInt(activityId) >> 22n);
  } catch {
    return 0;
  }
}

/** 从 GraphQL feed 响应里解析帖子本身，而不只是计数。 */
export function parseLinkedInGraphqlPosts(json: unknown): Map<string, LinkedInGraphqlPost> {
  const out = new Map<string, LinkedInGraphqlPost>();
  const feedData = findFeedRoot(json);
  if (!feedData) return out;

  const elements = (feedData["*elements"] || feedData.elements || []) as unknown[];
  const included = findIncludedArray(json);

  const includedByEntityUrn = new Map<string, JsonObject>();
  const updateByKey = new Map<string, JsonObject>();
  const socialDetailByKey = new Map<string, JsonObject>();
  const activityCountsByKey = new Map<string, JsonObject>();

  for (const item of included) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.$type || "");
    if (item.entityUrn) includedByEntityUrn.set(String(item.entityUrn), item);
    if (type === "com.linkedin.voyager.dash.feed.Update") {
      setLookupValue(updateByKey, buildUrnLookupKeys(
        item.entityUrn,
        item.preDashEntityUrn,
        item.metadata?.backendUrn,
        item.metadata?.shareUrn,
        item.socialContent?.shareUrl,
      ), item);
    } else if (type === "com.linkedin.voyager.dash.social.SocialDetail") {
      setLookupValue(socialDetailByKey, buildUrnLookupKeys(
        item.entityUrn,
        item.preDashEntityUrn,
        item.threadUrn,
        item["*totalSocialActivityCounts"],
      ), item);
    } else if (type === "com.linkedin.voyager.dash.feed.SocialActivityCounts") {
      setLookupValue(activityCountsByKey, buildUrnLookupKeys(
        item.urn,
        item.entityUrn,
        item.preDashEntityUrn,
      ), item);
    }
  }

  for (const elementUrn of elements) {
    const activityId = parseActivityId(elementUrn);
    if (!activityId) continue;
    const elementKeys = buildUrnLookupKeys(elementUrn, `urn:li:activity:${activityId}`);
    const update = includedByEntityUrn.get(String(elementUrn)) || getLookupValue(updateByKey, elementKeys);
    if (!update) continue;

    const socialDetailEntityUrn = update["*socialDetail"];
    const socialDetail = (socialDetailEntityUrn && includedByEntityUrn.get(String(socialDetailEntityUrn)))
      || getLookupValue(socialDetailByKey, buildUrnLookupKeys(socialDetailEntityUrn));
    const totalSocialActivityCountsEntityUrn = socialDetail?.["*totalSocialActivityCounts"];
    const directCounts = totalSocialActivityCountsEntityUrn
      ? includedByEntityUrn.get(String(totalSocialActivityCountsEntityUrn))
      : null;
    const counts = directCounts || getLookupValue(activityCountsByKey, buildUrnLookupKeys(
      elementUrn,
      `urn:li:activity:${activityId}`,
      update.metadata?.backendUrn,
      update.metadata?.shareUrn,
      update.entityUrn,
      update.preDashEntityUrn,
      update.socialContent?.shareUrl,
      socialDetail?.entityUrn,
      socialDetail?.preDashEntityUrn,
      socialDetail?.threadUrn,
      socialDetail?.["*totalSocialActivityCounts"],
    )) || {};

    const url = String(update.socialContent?.shareUrl || "").trim()
      || `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;

    out.set(activityId, {
      activityId,
      url,
      publishedTsMs: activityIdToTsMs(activityId),
      text: extractLinkedInText(update.commentary?.text || update.commentary || ""),
      likes: numberOrNull(counts.numLikes),
      comments: numberOrNull(counts.numComments),
      shares: numberOrNull(counts.numShares),
    });
  }

  return out;
}
