/**
 * 用抓包 fixture 验证 Facebook 主页 feed 的解析逻辑（不需要登录、不连库）。
 *
 * 支持两种抓包格式：
 *   1. 裸 GraphQL 响应流：每行一个 `{"data": {...}}` 或 `{"label","path","data","extensions"}`
 *      （即本次的 response.jsonl）
 *   2. 参考项目的中间层抓包：`{"ts","url","body"}`，body 里再逐行放 GraphQL 响应
 *      （changan-rpa/work/facebook_2026-10-24/raw_responses.jsonl）
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-facebook-parse.ts [file...]
 *
 * 不传文件时默认读 ./response.jsonl。
 * 退出码 1 表示一条帖子都没解析出来（说明结构又变了，需要重新对照）。
 */
import { readFileSync } from "node:fs";
import { collectStoryObjects, extractPost, parseJsonLine } from "../src/platforms/facebook.ts";
import { parseCount } from "../src/core/time.ts";

type Candidate = { postId: string; url: string; likeText: string; commentText: string; shareText: string; playText: string; ufiFormat: string; publishTsMs: number };

function payloadsOf(file: string): any[] {
  const out: any[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    // 中间层抓包：把 body 再拆成逐行的 GraphQL 响应
    if (typeof parsed?.body === "string") {
      for (const bodyLine of parsed.body.split(/\r?\n/)) {
        const inner = parseJsonLine(bodyLine);
        if (inner) out.push(inner);
      }
      continue;
    }
    out.push(parsed);
  }
  return out;
}

function postsOf(file: string): Candidate[] {
  const posts = new Map<string, Candidate>();
  let storyCount = 0;
  for (const payload of payloadsOf(file)) {
    for (const story of collectStoryObjects(payload)) {
      storyCount += 1;
      const post = extractPost(story);
      if (!post) continue;
      const key = post.postId || post.url;
      const current = posts.get(key);
      if (!current) {
        posts.set(key, post);
        continue;
      }
      posts.set(key, {
        ...current,
        ...post,
        likeText: post.likeText || current.likeText,
        commentText: post.commentText || current.commentText,
        shareText: post.shareText || current.shareText,
        playText: post.playText || current.playText,
        ufiFormat: post.ufiFormat !== "none" ? post.ufiFormat : current.ufiFormat,
      });
    }
  }
  console.log(`  Story 对象 ${storyCount} 个 → 去重后 ${posts.size} 条帖子`);
  return [...posts.values()].sort((a, b) => b.publishTsMs - a.publishTsMs);
}

function show(value: string): string {
  const count = parseCount(value);
  return value ? `${value} (${count})` : "—";
}

const files = process.argv.slice(2);
const targets = files.length ? files : ["response.jsonl"];
let total = 0;

for (const file of targets) {
  console.log(`\n=== ${file} ===`);
  let posts: Candidate[] = [];
  try {
    posts = postsOf(file);
  } catch (error) {
    console.error(`  读取失败：${(error as Error).message}`);
    continue;
  }
  total += posts.length;
  if (!posts.length) continue;

  const sources = new Map<string, number>();
  for (const post of posts) sources.set(post.ufiFormat, (sources.get(post.ufiFormat) || 0) + 1);
  const playMissing = posts.filter((post) => parseCount(post.playText) == null).length;

  for (const post of posts) {
    console.log(`  • ${post.postId}  ${post.url}`);
    console.log(
      `      赞 ${show(post.likeText)} | 评 ${show(post.commentText)} | 转 ${show(post.shareText)} | `
      + `播放 ${show(post.playText)} | 结构类型 ${post.ufiFormat}`,
    );
  }
  console.log(
    `  小结：帖子 ${posts.length} 条，结构类型 ${[...sources].map(([k, v]) => `${k}=${v}`).join(" ")}，`
    + `播放量缺失 ${playMissing} 条`,
  );
}

console.log(`\n合计解析出 ${total} 条帖子。`);
if (!total) {
  console.error("一条都没解析出来，Facebook 响应结构可能又变了。");
  process.exit(1);
}
