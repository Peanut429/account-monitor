import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./client.ts";
import type { AccountMetrics, AccountRow, PostRow, ScrapeLogExtra } from "../platforms/types.ts";

const CYCLE_LOCK_KEY = 72_819_001;
let lockClient: PoolClient | null = null;

export async function tryAcquireCycleLock(): Promise<boolean> {
  lockClient = await pool.connect();
  const result = await lockClient.query("select pg_try_advisory_lock($1) as locked", [CYCLE_LOCK_KEY]);
  if (!result.rows[0]?.locked) {
    lockClient.release();
    lockClient = null;
    return false;
  }
  return true;
}

export async function releaseCycleLock(): Promise<void> {
  if (!lockClient) return;
  try {
    await lockClient.query("select pg_advisory_unlock($1)", [CYCLE_LOCK_KEY]);
  } finally {
    lockClient.release();
    lockClient = null;
  }
}

export async function listAccounts(accountType: string): Promise<AccountRow[]> {
  const result = await pool.query(
    `select id, platform_code, handle, display_name, profile_url
     from accounts
     where active = true and account_type = $1
     order by platform_code, handle`,
    [accountType],
  );
  return result.rows.map((row) => ({
    id: row.id,
    platformCode: row.platform_code,
    handle: row.handle,
    displayName: row.display_name,
    profileUrl: row.profile_url,
  }));
}

export async function createCycle(windowStartTsMs: number, windowEndTsMs: number): Promise<string> {
  const id = `cyc-${randomUUID()}`;
  await pool.query(
    `insert into monitor_cycles (id, window_start_ts_ms, window_end_ts_ms, started_ts_ms, status)
     values ($1, $2, $3, $4, 'running')`,
    [id, windowStartTsMs, windowEndTsMs, Date.now()],
  );
  return id;
}

export async function finishCycle({
  cycleId,
  status,
  errorMessage,
}: {
  cycleId: string;
  status: "success" | "partial_failed" | "failed";
  errorMessage?: string | null;
}): Promise<void> {
  await pool.query(
    `update monitor_cycles
     set status = $2,
         finished_ts_ms = $3,
         error_message = $4,
         total_runs = (select count(*)::int from monitor_runs where cycle_id = $1),
         success_runs = (select count(*)::int from monitor_runs where cycle_id = $1 and status = 'success'),
         failed_runs = (select count(*)::int from monitor_runs where cycle_id = $1 and status = 'failed')
     where id = $1`,
    [cycleId, status, Date.now(), errorMessage || null],
  );
}

export async function createRun(cycleId: string, account: AccountRow): Promise<string> {
  const id = `run-${randomUUID()}`;
  await pool.query(
    `insert into monitor_runs (id, cycle_id, account_id, platform_code, status, started_ts_ms)
     values ($1, $2, $3, $4, 'running', $5)`,
    [id, cycleId, account.id, account.platformCode, Date.now()],
  );
  return id;
}

export async function finishRun({
  runId,
  status,
  postsFound,
  postsSaved,
  errorCode,
  errorMessage,
}: {
  runId: string;
  status: "success" | "failed";
  postsFound: number;
  postsSaved: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  await pool.query(
    `update monitor_runs
     set status = $2,
         finished_ts_ms = $3,
         posts_found = $4,
         posts_saved = $5,
         error_code = $6,
         error_message = $7
     where id = $1`,
    [runId, status, Date.now(), postsFound, postsSaved, errorCode || null, errorMessage || null],
  );
}

export async function saveRunResult({
  runId,
  account,
  posts,
  accountMetrics,
  capturedTsMs,
}: {
  runId: string;
  account: AccountRow;
  posts: PostRow[];
  accountMetrics: AccountMetrics;
  capturedTsMs: number;
}): Promise<number> {
  const uniquePosts = new Map<string, PostRow>();
  for (const post of posts) {
    if (!post.externalId || !post.url) continue;
    uniquePosts.set(post.externalId, post);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `insert into account_metrics
         (id, run_id, account_id, captured_ts_ms, followers, following, posts_count, raw_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (run_id) do update set
         captured_ts_ms = excluded.captured_ts_ms,
         followers = excluded.followers,
         following = excluded.following,
         posts_count = excluded.posts_count,
         raw_json = excluded.raw_json`,
      [
        `am-${randomUUID()}`,
        runId,
        account.id,
        capturedTsMs,
        accountMetrics.followers ?? null,
        accountMetrics.following ?? null,
        accountMetrics.postsCount ?? null,
        JSON.stringify(accountMetrics.raw ?? {}),
      ],
    );

    let saved = 0;
    for (const post of uniquePosts.values()) {
      const inserted = await client.query(
        `insert into posts
           (id, platform_code, account_id, external_post_id, url, content_type,
            published_ts_ms, published_precision, title, text_content,
            first_seen_ts_ms, last_seen_ts_ms, created_ts_ms, updated_ts_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11, $11)
         on conflict (platform_code, account_id, external_post_id) do update set
           url = excluded.url,
           content_type = coalesce(excluded.content_type, posts.content_type),
           published_ts_ms = coalesce(excluded.published_ts_ms, posts.published_ts_ms),
           published_precision = coalesce(excluded.published_precision, posts.published_precision),
           title = coalesce(excluded.title, posts.title),
           text_content = coalesce(excluded.text_content, posts.text_content),
           last_seen_ts_ms = excluded.last_seen_ts_ms,
           updated_ts_ms = excluded.updated_ts_ms
         returning id`,
        [
          `post-${randomUUID()}`,
          account.platformCode,
          account.id,
          post.externalId,
          post.url,
          post.contentType ?? null,
          post.publishedTsMs ?? null,
          post.publishedPrecision ?? null,
          post.title ?? null,
          post.text ?? null,
          capturedTsMs,
        ],
      );

      const postId = inserted.rows[0].id;
      const metrics = post.metrics || {};
      await client.query(
        `insert into post_metrics
           (id, run_id, post_id, captured_ts_ms, views, likes, comments, shares, saves, reads, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (run_id, post_id) do update set
           captured_ts_ms = excluded.captured_ts_ms,
           views = excluded.views,
           likes = excluded.likes,
           comments = excluded.comments,
           shares = excluded.shares,
           saves = excluded.saves,
           reads = excluded.reads,
           raw_json = excluded.raw_json`,
        [
          `pm-${randomUUID()}`,
          runId,
          postId,
          capturedTsMs,
          metrics.views ?? null,
          metrics.likes ?? null,
          metrics.comments ?? null,
          metrics.shares ?? null,
          metrics.saves ?? null,
          metrics.reads ?? null,
          JSON.stringify(post.raw ?? {}),
        ],
      );
      saved += 1;
    }

    await client.query("commit");
    return saved;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function writeLog({
  cycleId,
  runId,
  level,
  step,
  message,
  extra,
}: {
  cycleId?: string | null;
  runId?: string | null;
  level: "debug" | "info" | "warn" | "error";
  step: string;
  message: string;
  extra?: ScrapeLogExtra;
}): Promise<void> {
  await pool.query(
    `insert into run_logs
       (id, cycle_id, run_id, level, step, message, page_url, error_code, context_json, created_ts_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      `log-${randomUUID()}`,
      cycleId || null,
      runId || null,
      level,
      step,
      String(message).slice(0, 10_000),
      extra?.pageUrl || null,
      extra?.errorCode || null,
      JSON.stringify(extra?.context || {}),
      Date.now(),
    ],
  );
}
