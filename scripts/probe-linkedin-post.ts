/**
 * 诊断 LinkedIn 公司主页 feed 里的单条帖子：
 * 同时打印该卡片的 DOM 文案、RSC、GraphQL 三路数据。
 *
 * 用法（在已登录的 Windows 机器上）：
 *   node --experimental-strip-types scripts/probe-linkedin-post.ts "https://www.linkedin.com/company/changan-spain/posts/" 7520394501450977280
 *
 * 注意：默认抓的是公司主页 feed，不是帖子详情页；帖子详情只能用来对照。
 */
import { loadEnvFile } from "node:process";
import { chromium } from "playwright";
import { activityIdsFromRsc, parseRscFeed } from "../src/platforms/linkedin-rsc-parser.ts";
import { parseLinkedInGraphqlCounts } from "../src/platforms/linkedin-graphql-parser.ts";

for (const file of [".env", "../.env"]) {
  try {
    loadEnvFile(file);
    break;
  } catch {
    // ignore
  }
}

const url = process.argv[2] || "https://www.linkedin.com/company/changan-spain/posts/";
const activityId = process.argv[3] || url.match(/activity:(\d+)/)?.[1] || "";
if (!activityId) {
  console.error("请传入 activityId，例如：... " + url + " 7520394501450977280");
  process.exit(1);
}

const userDataDir = process.env.MONITOR_USER_DATA_DIR || "work/playwright-profile";
const executablePath = process.env.MONITOR_CHROME_EXECUTABLE || undefined;
const headless = process.env.MONITOR_HEADLESS === "1";

const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  executablePath,
  viewport: { width: 1280, height: 1000 },
  args: ["--disable-blink-features=AutomationControlled"],
});

try {
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    const w = window as any;
    w.__liRscBodies = [];
    w.__liGraphqlBodies = [];
    const originalFetch = w.fetch.bind(w);
    w.fetch = (...args: any[]) => {
      const input = args[0];
      const requestUrl = typeof input === "string" ? input : input?.url || String(input);
      const promise = originalFetch(...args);
      const target = /flagship-web\/(?:feed|rsc-action)/.test(requestUrl)
        ? "__liRscBodies"
        : /voyager\/api\/.*graphql/.test(requestUrl)
          ? "__liGraphqlBodies"
          : null;
      if (target) {
        promise.then((response: any) => {
          response.clone().text().then((text: string) => {
            w[target].push(text);
          }).catch(() => {});
        }).catch(() => {});
      }
      return promise;
    };
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(6_000);
  // 公司主页需要滚动才会渲染后续卡片
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.max(800, window.innerHeight * 1.2)));
    await page.waitForTimeout(1_500);
  }

  const dom = await page.evaluate((targetId) => {
    const cards = [...document.querySelectorAll('[data-urn*="urn:li:activity:"]')];
    const card = cards.find((node) => (node.getAttribute("data-urn") || "").includes(`activity:${targetId}`));
    const social = card?.querySelector(".social-details-social-counts");
    return {
      title: document.title,
      finalUrl: location.href,
      cardFound: Boolean(card),
      cardText: card?.textContent?.replace(/\s+/g, " ").trim() || "",
      socialText: social?.textContent?.replace(/\s+/g, " ").trim() || "",
      reactionCount: card?.querySelector(".social-details-social-counts__reactions-count")?.textContent?.trim() || "",
      labels: [...(card?.querySelectorAll("button, [aria-label]") || [])]
        .map((element) => element.getAttribute("aria-label") || element.textContent?.replace(/\s+/g, " ").trim() || "")
        .filter(Boolean),
      bodyTail: document.body.innerText.slice(-1200),
    };
  }, activityId);

  const bodies = await page.evaluate(() => {
    const w = window as any;
    return {
      rsc: Array.isArray(w.__liRscBodies) ? w.__liRscBodies.join("\n") : "",
      graphql: Array.isArray(w.__liGraphqlBodies) ? w.__liGraphqlBodies : [],
    };
  });

  const rscPosts = parseRscFeed(bodies.rsc, [activityId]);
  const graphqlCounts = new Map<string, { likes: number | null; comments: number | null; shares: number | null }>();
  for (const text of bodies.graphql) {
    try {
      for (const [id, counts] of parseLinkedInGraphqlCounts(JSON.parse(text))) {
        graphqlCounts.set(id, counts);
      }
    } catch {
      // ignore
    }
  }

  console.log(JSON.stringify({
    url,
    activityId,
    dom,
    rscBodies: bodies.rsc ? 1 : 0,
    graphqlBodies: bodies.graphql.length,
    rscCounts: rscPosts.find((post) => post.activityId === activityId) || null,
    graphqlCounts: graphqlCounts.get(activityId) || null,
    rscActivityIds: activityIdsFromRsc(bodies.rsc).slice(0, 10),
  }, null, 2));
} finally {
  await context.close();
}
