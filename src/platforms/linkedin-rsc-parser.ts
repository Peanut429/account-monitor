/**
 * LinkedIn 新版公司动态页（sdui / RSC）数据解析。
 *
 * LinkedIn 已把公司动态从老的 `/voyager/api/graphql`（JSON { data, meta, included }）
 * 迁移到 React Server Components（RSC / sdui）体系：
 *   - 首屏：`POST /flagship-web/feed/` 或初始 HTML（RSC 流）
 *   - 分页：`POST /flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.pagers.pages.organizationFeed`
 *
 * 这些响应 body 是 application/octet-stream 的 RSC 流（`1:I["hash",[],"Component"]`、
 * `["$","$Lxxx",null,{...}]`、`T<len>,{...}` 打标对象）。本文档只做「按字段抽取」，
 * 不做完整 RSC 反序列化。抽取时依赖以下可稳定出现的形态：
 *
 *   - 帖子主键：`urn:li:activity:<activityId>`（老 scraper 用的 externalContentId）
 *   - 互动计数：sdui state store 里的
 *       `commentCount-urn:li:activity:<id>` / `repostCount-urn:li:activity:<id>`
 *       `ReactionType_<TYPE>_urn:li:activity:<id>`（多种 ReactionType 求和 = 总回应数）
 *       这些键后面跟着 `"$case":"intValue","intValue":<n>`
 *       注意：视频/原创帖的计数键用的是 `urn:li:ugcPost:<ugcPostId>`，不是 activity URN，
 *       需要通过 `userGeneratedContentId -> activityId` 的共现关系映射回 activityId。
 *   - 帖子正文：SSR HTML 里的 `data-testid="expandable-text-box">…</span>` 文本块
 *       与 activityId 按文档顺序一一对应（当前页面成立，属顺序近似）
 *   - 发布时间：由 activityId 用 Snowflake 位运算推出（`id >> 22` 得到 UTC 毫秒），
 *       无需解析页面
 */

const REACTION_TYPES = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT", "SUPER_LIKE"];

const ACTIVITY_URN_RE = /urn:li:activity:(\d+)/g;

export type RscPost = {
  activityId: string;
  url: string;
  publishIso: string;
  likeCount: number | null;
  commentCount: number | null;
  repostCount: number | null;
  excerpt: string | null;
};

/** 从 activityId 用 Snowflake 位运算推出发布时刻的 ISO 字符串（UTC）。 */
export function publishIsoFromActivityId(activityId: string): string {
  try {
    const utcMs = Number(BigInt(activityId) >> 22n);
    return new Date(utcMs).toISOString();
  } catch {
    return "";
  }
}

function intValueAfter(text: string, needle: string): number | null {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  const seg = text.slice(i, i + 400);
  const m = /intValue\\?":(\d+)/.exec(seg);
  return m ? Number(m[1]) : null;
}

/**
 * 抽取 `activityId -> ugcPostId` 映射。
 * 视频/原创帖的互动计数在 state store 里用 `urn:li:ugcPost:<ugcPostId>` 做键，
 * 而帖子主键仍是 `urn:li:activity:<activityId>`，两者在 reaction/分享动作 payload 里共现：
 *   "userGeneratedContentId":"<ugcId>" ... "activityId":"<actId>"
 */
function ugcPostIdByActivityId(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /userGeneratedContentId":"(\d+)"[\s\S]{0,400}?activityId":"(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

function intValueAfterEither(text: string, aid: string, ugcId: string | undefined, keyPrefix: string): number | null {
  let v = intValueAfter(text, `${keyPrefix}-urn:li:activity:${aid}`);
  if (v == null && ugcId) v = intValueAfter(text, `${keyPrefix}-urn:li:ugcPost:${ugcId}`);
  return v;
}

function likeCount(text: string, aid: string, ugcId: string | undefined): number | null {
  let sum = 0;
  let any = false;
  for (const type of REACTION_TYPES) {
    let v = intValueAfter(text, `ReactionType_${type}_urn:li:activity:${aid}`);
    if (v == null && ugcId) v = intValueAfter(text, `ReactionType_${type}_urn:li:ugcPost:${ugcId}`);
    if (v != null) { sum += v; any = true; }
  }
  return any ? sum : null;
}

/** 拷贝 RSC 流里的帖子正文块（顺序与 activityId 出现顺序一致）。 */
export function extractCommentaryBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /data-testid="expandable-text-box">(.{0,3000}?)(?:<\/span>|<br)/gs;
  let m;
  while ((m = re.exec(text))) {
    const clean = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (clean) out.push(clean);
  }
  return out;
}

/** 按出现顺序去重列出所有 activityId（顺序与 SSR 渲染的帖子顺序一致）。 */
export function activityIdsInOrder(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  ACTIVITY_URN_RE.lastIndex = 0;
  while ((m = ACTIVITY_URN_RE.exec(text))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/**
 * 从单个 RSC 分页响应里，按 feed 顺序提取所有帖子的 activityId。
 * 来源：feed item 的 `viewTrackingSpecs.trackingScope[0].breadcrumb.content`（Buffer），
 * 解码后是 `{"updateUrn":"urn:li:activity:<id>"}`，这是唯一且与渲染顺序一致的可靠标识。
 */
export function activityIdsFromRsc(text: string): string[] {
  const chunks = new Map<string, any>();
  const re = /^([0-9a-f]+):(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let raw = m[2];
    if (raw.startsWith("I")) raw = raw.slice(1);
    else if (raw[0] === "T" || raw[0] === "J") raw = raw.slice(raw.indexOf(",") + 1);
    try { chunks.set(m[1], JSON.parse(raw)); } catch { /* ignore */ }
  }
  const root = chunks.get("0");
  if (!Array.isArray(root)) return [];

  const extractUrn = (node: any): string | null => {
    let found: string | null = null;
    const walk = (n: any, d: number) => {
      if (d > 40 || n == null || found) return;
      if (typeof n === "string") return;
      if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return; }
      if (typeof n === "object") {
        if (n.content && n.content.type === "Buffer" && Array.isArray(n.content.data)) {
          try {
            const o = JSON.parse(Buffer.from(n.content.data).toString("utf8"));
            if (o.updateUrn) found = String(o.updateUrn);
          } catch { /* ignore */ }
        }
        for (const k of Object.keys(n)) walk(n[k], d + 1);
      }
    };
    walk(node, 0);
    return found ? found.replace("urn:li:activity:", "") : null;
  };

  // 在 root 里找「feed items 数组」：第一个其元素能抽到 updateUrn 的数组
  for (const el of root) {
    if (!Array.isArray(el) || el.length === 0) continue;
    const urns: string[] = [];
    for (const it of el) {
      const u = extractUrn(it);
      if (u) urns.push(u);
    }
    if (urns.length >= 1) return urns;
  }
  return [];
}

/**
 * 从 RSC 文本抽取帖子列表。
 * 注意：正文（excerpt）不再从 feed 里抽取（feed 的正文有转发嵌套、会错位），
 * 由另一个程序按 url 单独解析。这里 excerpt 恒为 null。
 */
export function parseRscFeed(text: string, activityIds: string[]): RscPost[] {
  const ugcByActivity = ugcPostIdByActivityId(text);
  return activityIds.map((aid) => {
    const ugcId = ugcByActivity.get(aid);
    return {
      activityId: aid,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${aid}/`,
      publishIso: publishIsoFromActivityId(aid),
      likeCount: likeCount(text, aid, ugcId),
      commentCount: intValueAfterEither(text, aid, ugcId, "commentCount"),
      repostCount: intValueAfterEither(text, aid, ugcId, "repostCount"),
      excerpt: null,
    };
  });
}


