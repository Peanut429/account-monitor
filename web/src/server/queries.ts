import { createServerFn } from "@tanstack/react-start";
import { pool, rows } from "./db";
import type {
  AccountDetail,
  AccountListItem,
  AccountManagementData,
  CycleSummary,
  MetricSnapshot,
  ManagedAccount,
  Overview,
  PlatformOption,
  PlatformSummary,
  PostDetail,
  PostListItem,
  SnapshotRow,
} from "~/lib/types";

const WINDOW_MS = 72 * 3_600_000;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value);
  return result || null;
}

function metricFrom(row: any, prefix: string): MetricSnapshot {
  return {
    views: num(row[`${prefix}_views`]),
    likes: num(row[`${prefix}_likes`]),
    comments: num(row[`${prefix}_comments`]),
    shares: num(row[`${prefix}_shares`]),
    saves: num(row[`${prefix}_saves`]),
    reads: num(row[`${prefix}_reads`]),
  };
}

async function getOverviewData(): Promise<Overview> {
  const windowStart = Date.now() - WINDOW_MS;

  const [counts] = await rows<any>(
    `select
       (select count(*)::int from accounts where active = true) as accounts,
       (select count(*)::int
          from posts p
          join accounts a on a.id = p.account_id
         where a.active = true
           and coalesce(p.published_ts_ms, p.first_seen_ts_ms) >= $1) as posts_72h,
       (select count(*)::int
          from post_metrics pm
          join monitor_runs r on r.id = pm.run_id
          join accounts a on a.id = r.account_id
         where pm.captured_ts_ms >= $1) as snapshots_72h,
       (select count(*)::int
          from monitor_runs r
          join accounts a on a.id = r.account_id
         where r.started_ts_ms >= $1) as runs_72h,
       (select count(*)::int
          from monitor_runs r
          join accounts a on a.id = r.account_id
         where r.started_ts_ms >= $1 and r.status = 'failed') as failed_runs_72h`,
    [windowStart],
  );

  const [cycle] = await rows<any>(
    `select id, status, window_start_ts_ms, window_end_ts_ms, started_ts_ms, finished_ts_ms,
            total_runs, success_runs, failed_runs
       from monitor_cycles
      order by started_ts_ms desc
      limit 1`,
  );

  const platforms = await rows<any>(
    `select p.code, p.name,
            (select count(*)::int from accounts a
              where a.platform_code = p.code and a.active = true) as accounts,
            (select count(*)::int
               from posts po
               join accounts a on a.id = po.account_id
              where a.platform_code = p.code
                and coalesce(po.published_ts_ms, po.first_seen_ts_ms) >= $1) as posts_72h
       from platforms p
      where p.enabled = true
      order by p.code`,
    [windowStart],
  );

  return {
    accounts: int(counts?.accounts),
    posts72h: int(counts?.posts_72h),
    snapshots72h: int(counts?.snapshots_72h),
    runs72h: int(counts?.runs_72h),
    failedRuns72h: int(counts?.failed_runs_72h),
    latestCycle: cycle ? mapCycle(cycle) : null,
    platforms: platforms.map((row): PlatformSummary => ({
      code: row.code,
      name: row.name,
      accounts: int(row.accounts),
      posts72h: int(row.posts_72h),
    })),
  };
}

function mapCycle(row: any): CycleSummary {
  return {
    id: row.id,
    status: row.status,
    windowStartTsMs: int(row.window_start_ts_ms),
    windowEndTsMs: int(row.window_end_ts_ms),
    startedTsMs: int(row.started_ts_ms),
    finishedTsMs: num(row.finished_ts_ms),
    totalRuns: int(row.total_runs),
    successRuns: int(row.success_runs),
    failedRuns: int(row.failed_runs),
  };
}

async function getAccountsData(): Promise<AccountListItem[]> {
  const windowStart = Date.now() - WINDOW_MS;
  const data = await rows<any>(
    `select
       a.id, a.platform_code, p.name as platform_name, a.handle, a.display_name, a.profile_url,
       am.followers, am.following, am.posts_count, am.captured_ts_ms as metrics_captured_ts_ms,
       lr.status as last_run_status, lr.error_code as last_run_error_code,
       lr.error_message as last_run_error_message, lr.finished_ts_ms as last_run_finished_ts_ms,
       (select count(*)::int
          from posts po
         where po.account_id = a.id
           and coalesce(po.published_ts_ms, po.first_seen_ts_ms) >= $1) as posts_72h,
       (select count(*)::int
          from post_metrics pm
          join monitor_runs r on r.id = pm.run_id
         where r.account_id = a.id and pm.captured_ts_ms >= $1) as snapshots_72h
       from accounts a
       join platforms p on p.code = a.platform_code
       left join lateral (
         select * from account_metrics x
          where x.account_id = a.id
          order by x.captured_ts_ms desc
          limit 1
       ) am on true
       left join lateral (
         select * from monitor_runs x
          where x.account_id = a.id
          order by x.started_ts_ms desc
          limit 1
       ) lr on true
      where a.active = true
      order by p.code, a.handle`,
    [windowStart],
  );

  return data.map((row): AccountListItem => ({
    id: row.id,
    platformCode: row.platform_code,
    platformName: row.platform_name,
    handle: row.handle,
    displayName: text(row.display_name),
    profileUrl: row.profile_url,
    followers: num(row.followers),
    following: num(row.following),
    postsCount: num(row.posts_count),
    metricsCapturedTsMs: num(row.metrics_captured_ts_ms),
    lastRunStatus: text(row.last_run_status),
    lastRunErrorCode: text(row.last_run_error_code),
    lastRunErrorMessage: text(row.last_run_error_message),
    lastRunFinishedTsMs: num(row.last_run_finished_ts_ms),
    posts72h: int(row.posts_72h),
    snapshots72h: int(row.snapshots_72h),
  }));
}

async function getAccountData(accountId: string): Promise<AccountDetail | null> {
  const [row] = await rows<any>(
    `select
       a.id, a.platform_code, p.name as platform_name, a.handle, a.display_name, a.profile_url,
       a.account_type,
       am.followers, am.following, am.posts_count, am.captured_ts_ms as metrics_captured_ts_ms,
       lr.status as last_run_status, lr.error_code as last_run_error_code,
       lr.error_message as last_run_error_message, lr.finished_ts_ms as last_run_finished_ts_ms
       from accounts a
       join platforms p on p.code = a.platform_code
       left join lateral (
         select * from account_metrics x
          where x.account_id = a.id
          order by x.captured_ts_ms desc
          limit 1
       ) am on true
       left join lateral (
         select * from monitor_runs x
          where x.account_id = a.id
          order by x.started_ts_ms desc
          limit 1
       ) lr on true
      where a.id = $1`,
    [accountId],
  );

  if (!row) return null;
  return {
    id: row.id,
    platformCode: row.platform_code,
    platformName: row.platform_name,
    handle: row.handle,
    displayName: text(row.display_name),
    profileUrl: row.profile_url,
    accountType: text(row.account_type),
    followers: num(row.followers),
    following: num(row.following),
    postsCount: num(row.posts_count),
    metricsCapturedTsMs: num(row.metrics_captured_ts_ms),
    lastRunStatus: text(row.last_run_status),
    lastRunErrorCode: text(row.last_run_error_code),
    lastRunErrorMessage: text(row.last_run_error_message),
    lastRunFinishedTsMs: num(row.last_run_finished_ts_ms),
  };
}

async function getAccountPostsData(
  accountId: string,
  scope: "72h" | "all",
): Promise<PostListItem[]> {
  const windowStart = Date.now() - WINDOW_MS;
  const data = await rows<any>(
    `select
       po.id, po.url, po.content_type, po.published_ts_ms, po.title, po.text_content,
       po.first_seen_ts_ms, po.last_seen_ts_ms,
       lm.captured_ts_ms as latest_captured_ts_ms,
       lm.views as latest_views, lm.likes as latest_likes, lm.comments as latest_comments,
       lm.shares as latest_shares, lm.saves as latest_saves, lm.reads as latest_reads,
       fm.views as first_views, fm.likes as first_likes, fm.comments as first_comments,
       fm.shares as first_shares, fm.saves as first_saves, fm.reads as first_reads,
       coalesce(sc.snapshot_count, 0) as snapshot_count
       from posts po
       left join lateral (
         select * from post_metrics x
          where x.post_id = po.id
          order by x.captured_ts_ms desc
          limit 1
       ) lm on true
       left join lateral (
         select * from post_metrics x
          where x.post_id = po.id
          order by x.captured_ts_ms asc
          limit 1
       ) fm on true
       left join lateral (
         select count(*)::int as snapshot_count
           from post_metrics x
          where x.post_id = po.id
       ) sc on true
      where po.account_id = $1
        and ($2 = 'all' or coalesce(po.published_ts_ms, po.first_seen_ts_ms) >= $3)
      order by po.published_ts_ms desc nulls last, po.first_seen_ts_ms desc
      limit 500`,
    [accountId, scope, windowStart],
  );

  return data.map((row): PostListItem => ({
    id: row.id,
    url: row.url,
    contentType: text(row.content_type),
    publishedTsMs: num(row.published_ts_ms),
    title: text(row.title),
    text: text(row.text_content),
    firstSeenTsMs: int(row.first_seen_ts_ms),
    lastSeenTsMs: int(row.last_seen_ts_ms),
    latestCapturedTsMs: num(row.latest_captured_ts_ms),
    snapshotCount: int(row.snapshot_count),
    latest: metricFrom(row, "latest"),
    first: metricFrom(row, "first"),
  }));
}

async function getPostData(accountId: string, postId: string): Promise<PostDetail | null> {
  const [post] = await rows<any>(
    `select po.id, po.url, po.platform_code, po.account_id, po.content_type, po.published_ts_ms,
            po.title, po.text_content, po.first_seen_ts_ms, po.last_seen_ts_ms,
            a.handle, a.profile_url, p.name as platform_name
       from posts po
       join accounts a on a.id = po.account_id
       join platforms p on p.code = po.platform_code
      where po.id = $1 and po.account_id = $2`,
    [postId, accountId],
  );

  if (!post) return null;

  const snapshots = await rows<any>(
    `select pm.id, pm.captured_ts_ms, pm.views, pm.likes, pm.comments, pm.shares, pm.saves,
            pm.reads, pm.raw_json,
            r.status as run_status, r.error_message as run_error,
            c.id as cycle_id, c.status as cycle_status, c.started_ts_ms as cycle_started_ts_ms
       from post_metrics pm
       join monitor_runs r on r.id = pm.run_id
       join monitor_cycles c on c.id = r.cycle_id
      where pm.post_id = $1
      order by pm.captured_ts_ms asc`,
    [postId],
  );

  return {
    id: post.id,
    url: post.url,
    platformCode: post.platform_code,
    platformName: post.platform_name,
    accountId: post.account_id,
    handle: post.handle,
    profileUrl: post.profile_url,
    contentType: text(post.content_type),
    publishedTsMs: num(post.published_ts_ms),
    title: text(post.title),
    text: text(post.text_content),
    firstSeenTsMs: int(post.first_seen_ts_ms),
    lastSeenTsMs: int(post.last_seen_ts_ms),
    snapshots: snapshots.map((row): SnapshotRow => ({
      id: row.id,
      capturedTsMs: int(row.captured_ts_ms),
      views: num(row.views),
      likes: num(row.likes),
      comments: num(row.comments),
      shares: num(row.shares),
      saves: num(row.saves),
      reads: num(row.reads),
      runStatus: row.run_status,
      runError: text(row.run_error),
      cycleId: row.cycle_id,
      cycleStatus: row.cycle_status,
      cycleStartedTsMs: int(row.cycle_started_ts_ms),
      rawJson: row.raw_json,
    })),
  };
}


async function getAccountManagementData(): Promise<AccountManagementData> {
  const windowStart = Date.now() - WINDOW_MS;
  const [accounts, platforms] = await Promise.all([
    rows<any>(
      `select
         a.id, a.platform_code, p.name as platform_name, a.handle, a.display_name, a.profile_url,
         a.account_type, a.active, a.created_ts_ms,
         am.followers,
         lr.status as last_run_status, lr.error_message as last_run_error_message,
         lr.finished_ts_ms as last_run_finished_ts_ms,
         (select count(*)::int
            from posts po
           where po.account_id = a.id
             and coalesce(po.published_ts_ms, po.first_seen_ts_ms) >= $1) as posts_72h
         from accounts a
         join platforms p on p.code = a.platform_code
         left join lateral (
           select * from account_metrics x
            where x.account_id = a.id
            order by x.captured_ts_ms desc
            limit 1
         ) am on true
         left join lateral (
           select * from monitor_runs x
            where x.account_id = a.id
            order by x.started_ts_ms desc
            limit 1
         ) lr on true
        order by a.active desc, p.code, a.handle`,
      [windowStart],
    ),
    rows<any>(
      `select code, name from platforms where enabled = true order by code`,
    ),
  ]);

  return {
    accounts: accounts.map((row): ManagedAccount => ({
      id: row.id,
      platformCode: row.platform_code,
      platformName: row.platform_name,
      handle: row.handle,
      displayName: text(row.display_name),
      profileUrl: row.profile_url,
      accountType: text(row.account_type),
      active: Boolean(row.active),
      followers: num(row.followers),
      lastRunStatus: text(row.last_run_status),
      lastRunErrorMessage: text(row.last_run_error_message),
      lastRunFinishedTsMs: num(row.last_run_finished_ts_ms),
      posts72h: int(row.posts_72h),
      createdTsMs: int(row.created_ts_ms),
    })),
    platforms: platforms.map((row): PlatformOption => ({ code: row.code, name: row.name })),
  };
}

async function createAccountRecord(input: {
  platformCode: string;
  handle: string;
  displayName: string;
  profileUrl: string;
  accountType: string;
  active: boolean;
}): Promise<{ id: string }> {
  const platformCode = input.platformCode.trim();
  const handle = input.handle.trim();
  const displayName = input.displayName.trim() || handle;
  const profileUrl = input.profileUrl.trim();
  const accountType = input.accountType.trim() || "欧洲";

  if (!platformCode || !handle || !profileUrl) {
    throw new Error("平台、账号、主页链接都不能为空");
  }

  let parsed: URL;
  try {
    parsed = new URL(profileUrl);
  } catch {
    throw new Error("主页链接格式不正确，需要完整的 http/https 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("主页链接必须是 http/https 地址");
  }

  const platform = await rows<{ code: string }>(
    `select code from platforms where code = $1 and enabled = true`,
    [platformCode],
  );
  if (!platform.length) throw new Error(`平台不存在：${platformCode}`);

  const now = Date.now();
  try {
    const result = await pool.query(
      `insert into accounts
         (id, platform_code, handle, display_name, profile_url, account_type, active, metadata_json, created_ts_ms, updated_ts_ms)
       values ('acc-' || md5($1 || ':' || $2), $1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $7)
       returning id`,
      [platformCode, handle, displayName, profileUrl, accountType, input.active, now],
    );
    return { id: result.rows[0].id };
  } catch (error: any) {
    if (error?.code === "23505") {
      throw new Error(`账号已存在：${platformCode} / ${handle}。如果要恢复，请在列表里直接启用它。`);
    }
    throw error;
  }
}

async function setAccountActiveRecord(accountId: string, active: boolean): Promise<{ id: string; active: boolean }> {
  const result = await pool.query(
    `update accounts
        set active = $2, updated_ts_ms = $3
      where id = $1
      returning id, active`,
    [accountId, active, Date.now()],
  );
  if (!result.rowCount) throw new Error("账号不存在");
  return { id: result.rows[0].id, active: Boolean(result.rows[0].active) };
}

export const fetchOverview = createServerFn({ method: "GET" })
  .handler(() => getOverviewData());

export const fetchAccounts = createServerFn({ method: "GET" })
  .handler(() => getAccountsData());

export const fetchAccount = createServerFn({ method: "GET" })
  .validator((input: { accountId: string }) => ({ accountId: String(input?.accountId || "") }))
  .handler(({ data }) => getAccountData(data.accountId));

export const fetchAccountPosts = createServerFn({ method: "GET" })
  .validator((input: { accountId: string; scope?: string }) => ({
    accountId: String(input?.accountId || ""),
    scope: input?.scope === "all" ? "all" as const : "72h" as const,
  }))
  .handler(({ data }) => getAccountPostsData(data.accountId, data.scope));

export const fetchPost = createServerFn({ method: "GET" })
  .validator((input: { accountId: string; postId: string }) => ({
    accountId: String(input?.accountId || ""),
    postId: String(input?.postId || ""),
  }))
  .handler(({ data }) => getPostData(data.accountId, data.postId));

export const fetchAccountManagement = createServerFn({ method: "GET" })
  .handler(() => getAccountManagementData());

export const createManagedAccount = createServerFn({ method: "POST" })
  .validator((input: any) => ({
    platformCode: String(input?.platformCode || ""),
    handle: String(input?.handle || ""),
    displayName: String(input?.displayName || ""),
    profileUrl: String(input?.profileUrl || ""),
    accountType: String(input?.accountType || "欧洲"),
    active: input?.active !== false,
  }))
  .handler(({ data }) => createAccountRecord(data));

export const setManagedAccountActive = createServerFn({ method: "POST" })
  .validator((input: any) => ({
    accountId: String(input?.accountId || ""),
    active: input?.active === true,
  }))
  .handler(({ data }) => setAccountActiveRecord(data.accountId, data.active));
