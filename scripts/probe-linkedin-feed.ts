/**
 * 诊断 LinkedIn 公司主页 feed 为什么一条帖子卡片都解析不到。
 *
 * 必须在"跑监控的那台机器"上执行：脚本复用同一个 work/playwright-profile，
 * 所以看到的就是监控程序看到的登录态和页面。
 *
 * 用法：
 *   pnpm run li:probe
 *   pnpm run li:probe -- "https://www.linkedin.com/company/bydeurope/posts/"
 *   pnpm run li:probe -- "https://www.linkedin.com/company/changan-spain/posts/" --timeout 120000
 *
 * 产物：
 *   work/linkedin-probe/<时间戳>-<handle>.json   结构化报告
 *   work/linkedin-probe/<时间戳>-<handle>.html   完整 DOM（可直接用浏览器打开看）
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loadEnvFile } from "../src/config/env.ts";
import { browserExecutablePath, browserUserDataDir } from "../src/core/browser.ts";
import { parseLinkedInGraphqlPosts } from "../src/platforms/linkedin-graphql-parser.ts";
import { activityIdsInOrder } from "../src/platforms/linkedin-rsc-parser.ts";

loadEnvFile();

const args = process.argv.slice(2);
const positional = args.filter((item) => !item.startsWith("--"));
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const targetUrl = positional[0] || "https://www.linkedin.com/company/changan-spain/posts/";
const gotoTimeout = Number(flag("timeout", "90000"));
const handle = (targetUrl.match(/company\/([^/?#]+)/)?.[1] || "linkedin").replace(/[^\w.-]/g, "_");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve("work/linkedin-probe");
fs.mkdirSync(outDir, { recursive: true });

const headless = process.env.MONITOR_HEADLESS === "1";
console.log(`[probe] 打开 ${targetUrl}`);
console.log(`[probe] profile=${browserUserDataDir()} headless=${headless} chrome=${browserExecutablePath() || "playwright 自带"}`);

const context = await chromium.launchPersistentContext(browserUserDataDir(), {
  headless,
  executablePath: browserExecutablePath(),
  viewport: { width: 1440, height: 1000 },
  args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
});

// 所有和 feed 数据相关的请求，监控里看不到这层信息，这里是关键证据。
const requests: Array<{ url: string; status: number | null; type: string }> = [];
const interesting = /linkedin\.com\/(voyager|flagship-web|graphql|api)|flagship-web|\/graphql/i;

try {
  const page = context.pages()[0] || (await context.newPage());
  // CDP 层的 GraphQL 响应：和改完后的 adapter 用的是同一条路，直接验证解析结果。
  const apiBodies: unknown[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (!interesting.test(url)) return;
    requests.push({ url, status: response.status(), type: response.request().resourceType() });
    try {
      const pathname = new URL(url).pathname;
      if (!/\/voyager\/api\/.*graphql\b/i.test(pathname) && !/\/graphql\b/i.test(pathname)) return;
      void response.json().then((json) => {
        if (json && typeof json === "object") apiBodies.push(json);
      }).catch(() => {});
    } catch {
      // 非法 URL 忽略
    }
  });

  // 与 src/platforms/linkedin.ts 里的 installLinkedInCapture 完全一致的抓取逻辑，
  // 额外把命中的 URL 记下来，方便判断 LinkedIn 是不是换了接口路径。
  await page.addInitScript(() => {
    const w = window as any;
    w.__liRscBodies = [];
    w.__liRscUrls = [];
    w.__liGraphqlBodies = [];
    w.__liGraphqlUrls = [];
    const originalFetch = w.fetch.bind(w);
    w.fetch = (...fetchArgs: any[]) => {
      const input = fetchArgs[0];
      const requestUrl = typeof input === "string" ? input : input?.url || String(input);
      const promise = originalFetch(...fetchArgs);
      const target = /flagship-web\/(?:feed|rsc-action)/.test(requestUrl)
        ? "__liRscBodies"
        : /voyager\/api\/.*graphql/.test(requestUrl)
          ? "__liGraphqlBodies"
          : null;
      if (target) {
        promise.then((response: any) => {
          response.clone().text().then((text: string) => {
            w[target].push(text);
            w[target === "__liRscBodies" ? "__liRscUrls" : "__liGraphqlUrls"].push(requestUrl);
            if (w[target].length > 20) w[target].shift();
          }).catch(() => {});
        }).catch(() => {});
      }
      return promise;
    };
  });

  let gotoError = "";
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: gotoTimeout }).catch((error) => {
    gotoError = error instanceof Error ? error.message : String(error);
    return null;
  });
  const docHtml = response ? await response.text().catch(() => "") : "";
  // sdui 新版把公司动态随首屏文档下发，这是判断走哪条路的第一信号。
  const documentActivityIds = activityIdsInOrder(docHtml.replace(/\\+"/g, "\""));
  console.log(
    `[probe] 导航完成，HTTP ${response?.status() ?? "-"}，首屏 HTML ${docHtml.length} 字符，`
    + `文档内 activityId ${documentActivityIds.length} 个${gotoError ? `，错误：${gotoError}` : ""}`,
  );
  await page.waitForTimeout(6_000);

  const fingerprint = async (label: string) => page.evaluate((stage) => {
    const squash = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const urnNodes = [...document.querySelectorAll("[data-urn]")];
    const urnValues = [...new Set(urnNodes.map((node) => node.getAttribute("data-urn") || ""))];
    const urnKind: Record<string, number> = {};
    for (const urn of urnValues) {
      const kind = urn.split(":")[1] || "?";
      urnKind[kind] = (urnKind[kind] || 0) + 1;
    }
    const html = document.documentElement.outerHTML;
    const idsInHtml = [...new Set([...html.matchAll(/urn:li:activity:(\d+)/g)].map((match) => match[1]))];
    const dataAttrs = new Set<string>();
    for (const element of document.querySelectorAll("main *, .scaffold-layout *")) {
      for (const attribute of element.attributes) {
        if (attribute.name.startsWith("data-")) dataAttrs.add(attribute.name);
      }
    }
    const scrollables = [...document.querySelectorAll("main, main *")]
      .filter((element) => element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 100)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 5)
      .map((element) => `${element.tagName}#${element.id || "-"}.${squash(element.className).slice(0, 60)}`);

    return {
      finalUrl: location.href,
      title: document.title,
      readyState: document.readyState,
      counts: {
        dataUrn: urnNodes.length,
        activityUrn: document.querySelectorAll('[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"]').length,
        feedSharedUpdate: document.querySelectorAll(".feed-shared-update-v2").length,
        updateComponentsText: document.querySelectorAll(".update-components-text").length,
        main: document.querySelectorAll("main").length,
        roleList: document.querySelectorAll('main [role="list"]').length,
        iframes: document.querySelectorAll("iframe").length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        loginLinks: document.querySelectorAll('a[href*="/login"], a[href*="/authwall"], a[href*="/checkpoint"]').length,
        shadowHosts: [...document.querySelectorAll("*")].filter((element) => Boolean((element as any).shadowRoot)).length,
      },
      urnKind,
      urnSamples: urnValues.slice(0, 8),
      activityIdsInHtml: idsInHtml.slice(0, 8),
      activityIdCount: idsInHtml.length,
      feedUpdateAnchors: [...document.querySelectorAll('a[href*="/feed/update/"]')]
        .map((anchor) => anchor.getAttribute("href"))
        .slice(0, 5),
      dataAttributes: [...dataAttrs].slice(0, 40),
      scrollables,
      mainTextLength: squash(document.querySelector("main")?.innerText).length,
      bodyTextHead: squash(document.body.innerText).slice(0, 600),
      label: stage,
    };
  }, label);

  const before = await fingerprint("首屏");
  console.log(`[probe] 首屏：data-urn=${before.counts.dataUrn} activity-urn=${before.counts.activityUrn} HTML 内 activityId=${before.activityIdCount}`);

  // 和监控一样滚动 3 轮，确认不是"懒加载没触发"。
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("main, main *")]
        .filter((element) => element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 100);
      const primary = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (primary) {
        primary.scrollTop = Math.min(
          primary.scrollHeight - primary.clientHeight,
          primary.scrollTop + Math.max(400, Math.round(primary.clientHeight * 0.8)),
        );
        primary.dispatchEvent(new Event("scroll", { bubbles: true }));
        return;
      }
      window.scrollBy(0, Math.max(900, window.innerHeight * 1.7));
    });
    await page.waitForTimeout(2_500);
  }
  const after = await fingerprint("滚动3轮后");
  console.log(`[probe] 滚动后：data-urn=${after.counts.dataUrn} activity-urn=${after.counts.activityUrn}`);

  const captured = await page.evaluate(() => {
    const w = window as any;
    return {
      rscCount: (w.__liRscBodies || []).length,
      rscLength: (w.__liRscBodies || []).reduce((sum: number, body: string) => sum + body.length, 0),
      rscUrls: (w.__liRscUrls || []).slice(-5),
      graphqlCount: (w.__liGraphqlBodies || []).length,
      graphqlUrls: (w.__liGraphqlUrls || []).slice(-5),
    };
  });

  const html = await page.content();
  const htmlPath = path.join(outDir, `${stamp}-${handle}.html`);
  fs.writeFileSync(htmlPath, html);

  const apiPostIds = new Set<string>();
  for (const body of apiBodies) {
    try {
      for (const activityId of parseLinkedInGraphqlPosts(body).keys()) apiPostIds.add(activityId);
    } catch {
      // 忽略解析失败的响应
    }
  }
  console.log(`[probe] CDP 抓到 GraphQL 响应 ${apiBodies.length} 个，能解析出帖子 ${apiPostIds.size} 条`);

  const report = {
    targetUrl,
    finalUrl: after.finalUrl,
    gotoHttpStatus: response?.status() ?? null,
    gotoError,
    firstScreenHtmlLength: docHtml.length,
    before,
    after,
    captured,
    documentActivityIds: documentActivityIds.length,
    documentActivityIdSample: documentActivityIds.slice(0, 10),
    cdpGraphqlResponses: apiBodies.length,
    cdpParsedPosts: [...apiPostIds].slice(0, 20),
    feedRequests: requests.slice(-40),
    htmlPath,
  };
  const jsonPath = path.join(outDir, `${stamp}-${handle}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log("================ 结论 ================");
  if (documentActivityIds.length > 0) {
    console.log(`首屏文档里有 ${documentActivityIds.length} 个 activityId —— 走的是 sdui SSR（动态随文档下发），`);
    console.log("adapter 现在会直接用文档解析，不依赖 DOM 卡片，也不依赖 feed 请求。");
  }
  if (apiPostIds.size > 0) {
    console.log(`CDP 已经能抓到 GraphQL 帖子 ${apiPostIds.size} 条 —— 改完后的 adapter 会走这条主路径，不依赖 DOM。`);
  } else if (apiBodies.length > 0) {
    console.log(`CDP 抓到 ${apiBodies.length} 个 GraphQL 响应，但解析不出帖子 —— 响应结构又变了，看报告里的 feedRequests。`);
  } else {
    console.log("CDP 一个 GraphQL 响应都没抓到：页面可能走了 RSC/sdui，或者 feed 根本没发请求。");
  }
  if (after.counts.dataUrn > 0 && after.counts.activityUrn === 0) {
    console.log("有 data-urn 元素，但没有一个是 urn:li:activity:* —— LinkedIn 换了 urn 类型，");
    console.log("解析器要按下面的 urnKind 改：", JSON.stringify(after.urnKind));
  } else if (after.counts.dataUrn === 0 && after.activityIdCount > 0) {
    console.log("DOM 里能搜到 activityId，但不在 data-urn 属性上 —— 卡片身份改挂到了别的属性/链接上。");
    console.log("data-* 属性有：", after.dataAttributes.join(", "));
  } else if (after.counts.dataUrn === 0 && after.activityIdCount === 0) {
    console.log("整页没有任何 activityId —— 页面根本没渲染帖子列表。");
  } else {
    console.log("activity 卡片是存在的，问题在上层过滤逻辑，把下面的报告发我。");
  }
  if (/暂无企业快讯|还没有企业快讯|No company updates|No posts yet/i.test(after.bodyTextHead)) {
    console.log("页面文案命中『暂无企业快讯』：这个主页本身没有帖子。");
  }
  if (after.counts.loginLinks > 0 || /sign in|join now|登录/i.test(after.bodyTextHead)) {
    console.log("页面出现登录入口/登录文案：这个 profile 的 LinkedIn 登录态可能已经失效。");
  }
  if (after.counts.iframes > 0) console.log(`页面有 ${after.counts.iframes} 个 iframe，feed 可能在 iframe 里。`);
  if (after.counts.shadowHosts > 0) console.log(`页面有 ${after.counts.shadowHosts} 个 shadow root，querySelectorAll 看不到里面的内容。`);
  console.log("");
  console.log(`报告： ${jsonPath}`);
  console.log(`HTML： ${htmlPath}`);
  console.log("");
  console.log("------ 页面前 600 字 ------");
  console.log(after.bodyTextHead);
} finally {
  await context.close().catch(() => {});
}
