# 运行手册

## 1. 这个项目做什么

- 监控 6 个平台的欧洲账号主页：X、YouTube、Instagram、Facebook、LinkedIn、TikTok。
- 每个周期执行一次；每次窗口是执行时刻往前 72 小时，左闭右开：`[now-72h, now)`。
- 只抓主页帖子列表里可见的帖子，以及账号本身的粉丝/关注/帖子数。
- 窗口内每篇帖子写一条指标快照（`post_metrics`），所以同一帖子跨周期会有多条记录，可以直接算增长。
- 每次周期、每个账号的抓取结果、错误、日志都落库，失败不会静默。

## 2. 数据库

新库：`changan_monitor`（和参考项目同一个 PG 实例、同一个账号，只是库名不同）。

| 表 | 作用 |
|---|---|
| `platforms` | 6 个平台 |
| `accounts` | 账号 + 主页链接（`profile_url`） |
| `monitor_cycles` | 一次监控周期，带 72h 窗口 |
| `monitor_runs` | 周期内某个账号的一次抓取 |
| `posts` | 帖子身份（平台、账号、external_id、url、发布时间） |
| `post_metrics` | 某次 run 的帖子指标快照 |
| `account_metrics` | 某次 run 的账号指标快照 |
| `run_logs` | 步骤日志 |

视图：

- `v_cycle_summary`：每个周期的状态、账号数、帖子快照数。
- `v_latest_post_metrics`：每篇帖子最新一次指标。
- `v_post_growth`：同一帖子相邻快照的指标增量。

## 3. 首次配置

```bash
cd /Users/fuhui/outsourcing-projects/changan-monitor
pnpm install
pnpm run db:init
pnpm run db:sync-accounts
```

`db:sync-accounts` 会连参考库的 `changan_social_data`，把 `social_accounts.account_type = '欧洲'` 的启用账号同步到 `accounts`。目前是 41 个：

| 平台 | 账号数 |
|---|---:|
| facebook | 9 |
| instagram | 9 |
| linkedin | 7 |
| tiktok | 8 |
| x | 2 |
| youtube | 6 |

## 4. 登录

X / YouTube / Instagram / TikTok 已经改成 TikHub API，不需要浏览器登录。
只有 Facebook / LinkedIn 需要独立 Playwright profile：`work/playwright-profile`。

```bash
pnpm run login --platform facebook
pnpm run login --platform linkedin
```

`--platform all` 现在也只会打开这两个平台。每打开一个，在浏览器里完成登录，然后回终端按 Enter。

## 5. 跑一轮

```bash
pnpm run monitor
```

测试时只跑某个平台/账号：

```bash
pnpm run monitor --platform x
pnpm run monitor --platform youtube --account "BYD Europe"
pnpm run monitor --platform tiktok --limit 1
```

常用环境变量（`.env`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MONITOR_ACCOUNT_TYPE` | `欧洲` | 抓哪类账号 |
| `MONITOR_WINDOW_HOURS` | `72` | 窗口小时数 |
| `MONITOR_CONCURRENCY` | `3` | 同时抓几个账号 |
| `MONITOR_ACCOUNT_TIMEOUT_MS` | `300000` | 单账号超时 |
| `MONITOR_HEADLESS` | `0` | 0=有头浏览器，1=无头 |
| `MONITOR_USER_DATA_DIR` | `work/playwright-profile` | 浏览器 profile |
| `TIKHUB_API_KEY` | 空 | X / YouTube / Instagram / TikTok 共用 |
| `TIKHUB_MIN_INTERVAL_MS` | `80` | TikHub 请求最小间隔 |

运行逻辑：

1. 取 PG advisory lock；上一轮没结束就跳过。
2. 读 `accounts` 里 `active=true and account_type='欧洲'` 的账号。
3. 建 `monitor_cycles`，窗口 `[now-72h, now)`。
4. 每个账号建 `monitor_runs`，按平台 adapter 抓取。
5. 帖子和指标在一个事务里写入；成功/失败都更新 run。
6. 周期结束更新 `monitor_cycles` 汇总；有失败进程退出码为 1。

## 6. 每小时定时

macOS launchd：

```bash
cp deploy/com.changan.monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.changan.monitor.plist
```

查看/停止：

```bash
launchctl list | grep changan.monitor
launchctl unload ~/Library/LaunchAgents/com.changan.monitor.plist
```

日志：

- `logs/monitor.log`：每轮抓取日志
- `logs/launchd.out.log` / `logs/launchd.err.log`：launchd 自身日志

注意：Mac 休眠会漏跑；要严格每小时，建议放一台不休眠的机器/服务器。

## 7. 常用查询

最近 10 个周期：

```sql
select id, status, window_start_ts_ms, window_end_ts_ms, total_runs, success_runs, failed_runs, post_snapshots
from v_cycle_summary
order by started_ts_ms desc
limit 10;
```

某篇帖子的指标变化：

```sql
select p.url, pm.captured_ts_ms, pm.views, pm.likes, pm.comments, pm.shares
from post_metrics pm
join posts p on p.id = pm.post_id
where p.url = '...'
order by pm.captured_ts_ms;
```

最近一次各账号抓取结果：

```sql
select a.platform_code, a.handle, r.status, r.posts_found, r.posts_saved, r.error_message
from monitor_runs r
join accounts a on a.id = r.account_id
where r.cycle_id = (select id from monitor_cycles order by started_ts_ms desc limit 1)
order by a.platform_code, a.handle;
```

## 8. 已知限制 / 排错

- **数据源**：X / YouTube / Instagram / TikTok 走 TikHub API，不需要浏览器登录；Facebook / LinkedIn 走浏览器，需要登录。登录失效时 run 会失败并写 `LOGIN_REQUIRED` 类错误，重新跑 `pnpm run login --platform <平台>`。
- **TikHub key**：`.env` 里的 `TIKHUB_API_KEY` 是 4 个 API 平台共用的；缺失、过期、额度不足会直接报 401/402/429，不会静默跳过。`TIKHUB_MIN_INTERVAL_MS` 控制请求间隔，默认 80ms。
- **Instagram 降级**：用户帖子列表先走 v1 `fetch_user_posts`，失败或缺 `taken_at` 时降级 v2 `fetch_user_posts`；某条帖子列表里没有指标时，再按 v2 `fetch_post_info` → v1 `fetch_post_by_url` 取单帖指标。降级会写 `warn` 日志。
- **X**：TikHub 用户资料 + 用户发帖时间线；接口返回什么就入库什么。
- **YouTube**：TikHub `get_channel_videos` + `get_channel_shorts` 拿列表，再逐条 `get_video_info` 取精确发布时间/播放/点赞/评论。72h 内视频多时会多花 API 请求。
- **TikTok**：TikHub 先解析 `sec_user_id`，再取用户资料和主页作品列表。
- **系统代理**：API 平台只走 Node 直连 TikHub，不依赖 Chrome 代理；Facebook / LinkedIn 的浏览器仍然走系统代理。
- **0 帖**：账号 72h 没发帖是正常成功，`posts_found=0`，不是失败。
- **周期重叠**：每小时一轮意味着每篇帖子最多 72 条快照；`post_metrics` 的唯一键是 `(run_id, post_id)`，不会重复。
- **并发**：默认 3。LinkedIn/Facebook 如果触发风控，调小 `MONITOR_CONCURRENCY`。


## 9. Web 页面

`web/` 是 TanStack Start 应用，直接读 `changan_monitor`，不经过爬虫进程。

### 启动

```bash
cd /Users/fuhui/outsourcing-projects/changan-monitor/web
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:3000>。也可以在项目根目录跑：

```bash
pnpm run web:dev
```

`web/src/server/db.ts` 会依次尝试 `web/.env`、项目根 `.env`，不需要重复配置数据库。

### 页面结构

| 路径 | 内容 |
|---|---|
| `/` | 账号列表：平台筛选、搜索、粉丝/帖子数/近 72h 帖子/快照数/最近抓取/状态 |
| `/accounts/:accountId` | 账号详情：账号指标 + 帖子列表（近 72h / 全部历史） |
| `/accounts/:accountId/posts/:postId` | 帖子详情：最新指标、增长、4 张趋势图、全部快照、原始 JSON、CSV 导出 |

### 数据口径

- “近 72h 帖子”按帖子发布时间过滤，不是按入库时间。
- “快照”是 `post_metrics` 里这个帖子目前的记录数，不是固定 72 条。
- 一篇帖子最完整约 72 条：每小时一条、帖子一直在 72h 窗口内。实际会少，原因包括：
  - 帖子是刚发布的，还没满 72h；
  - 账号刚加入监控；
  - 某几轮抓取失败，或上一轮没跑完被锁跳过；
  - 帖子被删除/隐藏，平台不再返回；
  - 平台发布时间只能到日期，边界会有误差。
- 帖子详情会把相邻快照间隔超过 1.5 小时的记录标出来，方便看缺口。

### 构建

```bash
pnpm run web:build
```

当前本地看数据用 `pnpm dev` 就够了；要长期挂后台，可以给 web 也配一个 launchd，或者用 `vite preview`/Node 跑构建产物。


## 10. Windows 运行

`deploy/com.changan.monitor.plist` 是 macOS launchd 专用，Windows 不能用，也不需要它。
Windows 用 `scripts/run-monitor.bat` + 任务计划程序。

### 10.1 环境

- Node.js 24（要支持 `--experimental-strip-types`）
- pnpm
- Google Chrome
- 在项目根目录执行过 `pnpm install` 和 `pnpm run db:init` / `db:sync-accounts`

`.env` 里 Chrome 路径改成 Windows 的，例如：

```dotenv
MONITOR_CHROME_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe
```

`MONITOR_USER_DATA_DIR` 保持 `work/playwright-profile` 即可，代码里会按项目目录解析。
TikHub 的 4 个平台不需要 Chrome；只有 Facebook / LinkedIn 会用到。

### 10.2 手动跑

```bat
cd C:\path\to\changan-monitor
pnpm run monitor
```

或者直接双击/执行：

```bat
scripts\run-monitor.bat
```

日志在 `logs\monitor.log`。

### 10.3 任务计划程序（每小时）

用管理员或当前用户打开 cmd，执行（把路径换成实际项目路径）：

```bat
schtasks /Create /TN "ChanganMonitor" /TR "C:\path\to\changan-monitor\scripts\run-monitor.bat" /SC HOURLY /MO 1 /ST 00:05 /RL LIMITED /IT /F
```

说明：

- `/SC HOURLY /MO 1`：每小时一次，从 `00:05` 开始。
- `/IT`：只在当前用户登录时运行。Facebook / LinkedIn 需要可见浏览器，必须保留这个参数；不要用“不管用户是否登录都要运行”的服务方式。
- `/RL LIMITED`：普通权限运行。

查看/删除：

```bat
schtasks /Query /TN "ChanganMonitor" /V /FO LIST
schtasks /Delete /TN "ChanganMonitor" /F
```

如果 Windows 会休眠，任务同样可能漏跑；要严格每小时，需要关闭休眠或放服务器。

### 10.4 Web 页面

```bat
cd C:\path\to\changan-monitor
pnpm run web:dev
```

打开 <http://127.0.0.1:3000>。Web 是常驻进程，和监控的每小时任务分开；要开机常驻可以再用任务计划程序/NSSM 托管。
