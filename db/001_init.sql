-- 账号监控库：平台 / 账号 / 周期 / 抓取任务 / 帖子 / 指标快照 / 日志
-- 每次监控周期都会为窗口内每篇帖子写一条新的 post_metrics 快照。

create extension if not exists pgcrypto;

-- =========================
-- 1. 平台
-- =========================
create table if not exists platforms (
  code text primary key,
  name text not null,
  enabled boolean not null default true
);

comment on table platforms is '监控平台，code 与平台 adapter 的 code 一致';

-- =========================
-- 2. 账号（平台 + 主页链接）
-- =========================
create table if not exists accounts (
  id text primary key,
  platform_code text not null references platforms(code),
  handle text not null,
  display_name text,
  profile_url text not null,
  account_type text,
  active boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null,

  constraint uq_accounts_platform_handle unique (platform_code, handle)
);

comment on table accounts is '监控账号；profile_url 就是抓取时直接打开的主页链接';
comment on column accounts.account_type is '账号分类，例如 欧洲';

create index if not exists idx_accounts_platform on accounts(platform_code);
create index if not exists idx_accounts_active on accounts(active);
create index if not exists idx_accounts_type on accounts(account_type);

-- =========================
-- 3. 监控周期
-- =========================
create table if not exists monitor_cycles (
  id text primary key,
  window_start_ts_ms bigint not null,
  window_end_ts_ms bigint not null,
  started_ts_ms bigint not null,
  finished_ts_ms bigint,
  status text not null,
  total_runs int not null default 0,
  success_runs int not null default 0,
  failed_runs int not null default 0,
  error_message text,

  constraint ck_monitor_cycles_status check (
    status in ('running', 'success', 'partial_failed', 'failed')
  )
);

comment on table monitor_cycles is '一次监控周期；window_start/window_end 通常是 [now-72h, now)';

create index if not exists idx_monitor_cycles_started on monitor_cycles(started_ts_ms desc);

-- =========================
-- 4. 单账号抓取任务
-- =========================
create table if not exists monitor_runs (
  id text primary key,
  cycle_id text not null references monitor_cycles(id) on delete cascade,
  account_id text not null references accounts(id),
  platform_code text not null references platforms(code),
  status text not null,
  started_ts_ms bigint not null,
  finished_ts_ms bigint,
  posts_found int not null default 0,
  posts_saved int not null default 0,
  error_code text,
  error_message text,

  constraint uq_monitor_runs_cycle_account unique (cycle_id, account_id),
  constraint ck_monitor_runs_status check (
    status in ('running', 'success', 'failed')
  )
);

comment on table monitor_runs is '周期内某个账号的一次抓取';

create index if not exists idx_monitor_runs_cycle on monitor_runs(cycle_id);
create index if not exists idx_monitor_runs_account on monitor_runs(account_id);
create index if not exists idx_monitor_runs_started on monitor_runs(started_ts_ms desc);
create index if not exists idx_monitor_runs_account_started on monitor_runs(account_id, started_ts_ms desc);

-- =========================
-- 5. 帖子身份
-- =========================
create table if not exists posts (
  id text primary key,
  platform_code text not null,
  account_id text not null references accounts(id),
  external_post_id text not null,
  url text not null,
  content_type text,
  published_ts_ms bigint,
  published_precision text,
  title text,
  text_content text,
  first_seen_ts_ms bigint not null,
  last_seen_ts_ms bigint not null,
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null,

  constraint uq_posts_platform_account_external unique (platform_code, account_id, external_post_id)
);

comment on table posts is '帖子/视频的稳定身份，不含随时间变化的指标';
comment on column posts.published_precision is '发布时间精度：second/min/day/relative/unknown';

create index if not exists idx_posts_account on posts(account_id);
create index if not exists idx_posts_published on posts(published_ts_ms desc);
create index if not exists idx_posts_account_published on posts(account_id, published_ts_ms desc);

-- =========================
-- 6. 帖子指标快照
-- =========================
create table if not exists post_metrics (
  id text primary key,
  run_id text not null references monitor_runs(id) on delete cascade,
  post_id text not null references posts(id),
  captured_ts_ms bigint not null,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  reads bigint,
  raw_json jsonb not null default '{}'::jsonb,

  constraint uq_post_metrics_run_post unique (run_id, post_id)
);

comment on table post_metrics is '某次 run 抓到的帖子指标快照；同一帖子每个周期一条';

create index if not exists idx_post_metrics_run on post_metrics(run_id);
create index if not exists idx_post_metrics_post_time on post_metrics(post_id, captured_ts_ms desc);
create index if not exists idx_post_metrics_captured on post_metrics(captured_ts_ms desc);

-- =========================
-- 7. 账号指标快照
-- =========================
create table if not exists account_metrics (
  id text primary key,
  run_id text not null references monitor_runs(id) on delete cascade,
  account_id text not null references accounts(id),
  captured_ts_ms bigint not null,
  followers bigint,
  following bigint,
  posts_count bigint,
  raw_json jsonb not null default '{}'::jsonb,

  constraint uq_account_metrics_run unique (run_id)
);

comment on table account_metrics is '某次 run 抓到的账号指标快照';

-- =========================
-- 8. 日志
-- =========================
create table if not exists run_logs (
  id text primary key,
  cycle_id text references monitor_cycles(id) on delete cascade,
  run_id text references monitor_runs(id) on delete cascade,
  level text not null,
  step text not null,
  message text not null,
  page_url text,
  error_code text,
  context_json jsonb not null default '{}'::jsonb,
  created_ts_ms bigint not null,

  constraint ck_run_logs_level check (level in ('debug', 'info', 'warn', 'error'))
);

create index if not exists idx_run_logs_cycle on run_logs(cycle_id);
create index if not exists idx_run_logs_run on run_logs(run_id);
create index if not exists idx_run_logs_created on run_logs(created_ts_ms desc);

-- =========================
-- 9. 查询视图
-- =========================
create or replace view v_cycle_summary as
select
  c.id,
  c.window_start_ts_ms,
  c.window_end_ts_ms,
  c.started_ts_ms,
  c.finished_ts_ms,
  c.status,
  c.total_runs,
  c.success_runs,
  c.failed_runs,
  c.error_message,
  coalesce((
    select count(*)::int
    from post_metrics pm
    join monitor_runs r on r.id = pm.run_id
    where r.cycle_id = c.id
  ), 0) as post_snapshots
from monitor_cycles c;

create or replace view v_latest_post_metrics as
select distinct on (pm.post_id)
  pm.post_id,
  p.platform_code,
  p.account_id,
  a.handle,
  p.url,
  p.published_ts_ms,
  pm.run_id,
  pm.captured_ts_ms,
  pm.views,
  pm.likes,
  pm.comments,
  pm.shares,
  pm.saves,
  pm.reads
from post_metrics pm
join posts p on p.id = pm.post_id
join accounts a on a.id = p.account_id
order by pm.post_id, pm.captured_ts_ms desc;

create or replace view v_post_growth as
select
  post_id,
  captured_ts_ms,
  likes,
  likes - lag(likes) over (partition by post_id order by captured_ts_ms) as likes_delta,
  comments,
  comments - lag(comments) over (partition by post_id order by captured_ts_ms) as comments_delta,
  shares,
  shares - lag(shares) over (partition by post_id order by captured_ts_ms) as shares_delta,
  views,
  views - lag(views) over (partition by post_id order by captured_ts_ms) as views_delta
from post_metrics;
