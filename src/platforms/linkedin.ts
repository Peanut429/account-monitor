import type { Page } from "playwright";
import { parseCount } from "../core/time.ts";
import type { PlatformAdapter, PostRow, ScrapeContext, ScrapeResult } from "./types.ts";

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

function pickCount(labels: string[], countsText: string, pattern: RegExp): number | null {
  for (const value of [...labels, countsText]) {
    const match = pattern.exec(String(value || ""));
    if (match) {
      const parsed = parseCount(match[1]);
      if (parsed != null) return parsed;
    }
  }
  return null;
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
      const labels = [...container.querySelectorAll(".social-details-social-counts button")]
        .map((button) => button.getAttribute("aria-label") || text(button))
        .filter(Boolean);

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
      followersText: /([\d.,]+\s*[KMB]?)\s*followers?/i.exec(body)?.[1] || "",
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
  await page.goto(account.profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
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
          likes: pickCount(card.labels, card.countsText, /([\d.,]+\s*[KMB]?)\s*(?:reactions?|likes?)/i),
          comments: pickCount(card.labels, card.countsText, /([\d.,]+\s*[KMB]?)\s*comments?/i),
          shares: pickCount(card.labels, card.countsText, /([\d.,]+\s*[KMB]?)\s*(?:reposts?|shares?)/i),
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
