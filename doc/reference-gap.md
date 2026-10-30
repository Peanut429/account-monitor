# Facebook / LinkedIn 与参考项目差异清单

参考项目：`/Users/fuhui/outsourcing-projects/changan-rpa`

范围：只对照浏览器采集、解析、停止条件、数据口径。
不移植参考项目的 CLI 参数、Excel 导出、checkpoint 文件、参考库落库；这些由本项目的 `monitor_cycles` / `monitor_runs` / `post_metrics` 替代。

## Facebook

参考入口：`src/jobs/daily-scrape.ts` -> `src/platforms/facebook-network.ts`

| 参考项目 | 当前实现 | 状态 |
|---|---|---|
| GraphQL `facebook.com/api/graphql` 响应收集 | 已实现 | 已对齐 |
| `Story` / `timeline_list_feed_units` 解析 | 已实现，另有递归兜底 | 基本对齐 |
| `feedback.reaction_count/comments/share/play` | 已实现 | 已对齐 |
| network + DOM 合并 | 网络为主，DOM 独有帖子补入并按 URL 合并 | 已对齐 |
| DOM 首屏兜底 | 接口无数据时用 DOM 补帖；有数据时也补 DOM 独有帖子 | 已对齐 |
| `isPinned` 置顶判断 | 已支持文本/标题线判断 | 已对齐 |
| `stopAfterBeforeRange = 3` | 已复刻 `facebook-network-stop.ts` | 已对齐 |
| 连续 6 轮无新增 + 底部确认 3 次 | 已实现 | 已对齐 |
| `waitForFacebookReady` / `assertLoggedIn` | 已实现简化版 | 已对齐 |
| tooltip 精确时间 | 已移植，只对最终 DOM 结果做一次 | 已对齐 |
| 首屏异常错误码（TIMEOUT/PARSE_EMPTY） | 已接入 `FACEBOOK_FIRST_SCREEN_*` | 已对齐 |
| 首屏 0 帖子自动重载重试（`FIRST_SCREEN_MAX_RETRIES`） | 已实现，参考项目 3 次，本项目 2 次（受单账号 300s 超时约束），见下节 | 已对齐（次数不同） |
| owner 过滤 | 参考项目也没有强过滤 | 无差异 |
| checkpoint / Excel / CLI | 本项目不需要 | 不适用 |

### Facebook 的两类 UFI 结构（账号维度，长期并存）

同一份主页 feed，按账号返回两套结构，两种都要解析，**不是等 Facebook 修好的临时兼容**：

| | classic（能看播放量） | adaptive（看不到播放量） |
|---|---|---|
| renderer `__typename` | `DefaultCometUFISummaryAndActionsRenderer` | `DefaultModernCometUFISummaryAndActionsRenderer` |
| 赞/评论/转发 | 直接挂在 summary feedback 上 | 在 `adaptive_ufi_action_renderers[]` 里按 `__typename` 分辨 |
| 播放量 | `video_view_count_renderer.feedback.play_count` | **整份响应没有播放量字段**（`story.view_count` 恒为 null） |
| 目前覆盖账号 | 自己的账号 | 其余账号 |

- 解析顺序：先取 classic 的扁平字段，取不到再取 adaptive。classic 里 `adaptive_ufi_action_renderers` 也存在，但 feedback 只有 `id` 没有计数，所以不会读到错值。
- adaptive 类型 `post_metrics.views` 固定为 `null`，不写 0；`raw_json.ufiFormat` 记录该帖属于哪一类，日志 `parsed` 会输出两类各多少条。
- `media.loop_count` 是预览循环次数，不是播放量。
- 回归方式：`pnpm run fb:parse <抓包文件>`，stdout 会打印每条帖子的赞/评/转/播放和结构类型。

### Facebook 首屏卡死重试（2026-10-31）

线上会出现：主页左栏（资料、照片）已经渲染，右栏却是骨架屏，底部提示“用时超出预期”
（英文 “This is taking longer than expected”）。此时 feed 首屏请求已经放弃，DOM 里没有
`TimelineFeedUnit` 卡片、接口也没有 Story，继续滚动永远拿不到帖子。

参考项目 `facebook-network.ts` 用 `FIRST_SCREEN_MAX_RETRIES = 3` + `page.reload()` 处理。
本项目对齐该行为：

- 首屏判定：`waitForFirstScreen` 轮询卡片数；出现“用时超出预期”且 8 秒内仍无卡片 → 判定卡死；
  卡片正常出现则等数量稳定（沿用 `waitForStablePosts`），不再有额外的 30 秒空等。
- 重试条件：卡片 = 0 **且** 网络监听也没抓到帖子；只要接口已抓到帖子就不重载。
- 重载方式：第 1 次 `page.reload()`，第 2 次先 `about:blank` 再重新打开（软 reload 会复用卡死的前端状态）。
- 上限：`FACEBOOK_FIRST_SCREEN_RETRIES`（默认 2，0 = 关闭）+ `FACEBOOK_FIRST_SCREEN_RETRY_BUDGET_MS`
  （默认 180s），避免耗光 `MONITOR_ACCOUNT_TIMEOUT_MS`。每次重载写 `warn` 日志 `facebook_retry`，
  恢复后写 `info` 日志 `facebook_retry_ok`。
- 重试耗尽：直接报 `FACEBOOK_FIRST_SCREEN_TIMEOUT`，消息里带“用时超出预期”、重试次数和页面文本片段；
  不再浪费 6 轮滚动去确认空页面。
- 登录/验证页不重试，直接按 `LOGIN_REQUIRED` 失败。
- 回归：`pnpm run fb:retry`（假 page + 虚拟时钟，覆盖卡死后恢复、重试耗尽、关闭重试、
  无提示超时、接口有帖子但 DOM 无卡片 5 个场景）。

## LinkedIn

参考入口：`linkedin-auto.ts` -> `linkedin-network.ts` / `linkedin-rsc.ts`

| 参考项目 | 当前实现 | 状态 |
|---|---|---|
| `linkedin-rsc-parser.ts` | 原样复制，2026-10-31 同步到 `0b24248` | 已对齐 |
| RSC `ReactionType_*` / comment / repost | 已实现 | 已对齐 |
| GraphQL `SocialActivityCounts` counts | 已实现 | 已对齐 |
| GraphQL feed 帖子正文/URL/时间 | 已实现 `parseLinkedInGraphqlPosts` | 已对齐 |
| RSC feed 帖子列表 | 已实现，作为补充来源 | 已对齐 |
| API 帖子补进结果 | 已实现 GraphQL/RSC 补帖 | 已对齐 |
| `linkedin-auto` 先探测一次 | 探测门闩串行化，首个账号判定后其余复用 | 已对齐 |
| graphql/rsc 模式选择 | 缓存后复用，API 优先 | 已对齐 |
| 公司动态排序切“最近” | 支持 #sort-dropdown-trigger 和旧版按钮 | 已对齐 |
| 开放式滚动/分页响应计数 | 滚动 LinkedIn main 容器；按日期边界/稳定轮停止 | 已对齐 |
| 连续 3 条早于窗口停止 | DOM 卡片 + API 帖子都参与 | 已对齐 |
| 无帖子页面判断 | 已处理“暂无企业快讯” | 已对齐 |
| 目标公司页重定向校验 | 已移植路径校验 | 已对齐 |
| DOM 卡片外层 | 仍保留，作为兜底 | 与参考不同但保留 |
| 新版 sdui 分页抓取（pagination 拦截、按窗口起点停止） | 已实现，见下节 | 已对齐（2026-10-31） |
| 帖子身份提取 | `[data-urn*=urn:li:activity:]` 单属性 | 已改为多来源提取（属性 + 链接 + 文案正则） |
| sdui 首屏文档解析 | 2026-10-31 已同步 `0b24248` | 已对齐，见下节 |
| checkpoint / Excel / CLI | 本项目不需要 | 不适用 |

### LinkedIn 新版 sdui 分页抓取（2026-10-31）

10-30 00:00Z 起 19 个 LinkedIn 账号全部失败（错误信息是“没有解析到主页帖子”）。用 ego 浏览器
打开线上公司动态页确认：页面已经是 sdui 版本，DOM 里既没有 `data-urn`，也没有
`.feed-shared-update-v2` 卡片，帖子文本和计数只在两类 RSC 数据里：

- 首屏：随导航文档 SSR 下发（文档里 `urn:li:activity:<id>` + `commentCount-…` / `ReactionType_…`）；
- 之后：每滚一屏 `POST /flagship-web/rsc-action/actions/pagination` 返回一份 2-6MB 的 RSC。

旧实现用 DOM 卡片驱动滚动和停止条件，DOM 一空就只滚固定 6 轮，帖子只能等最后一次性合并；
分页 body 还会在页面 `window.__liRscBodies` 里越堆越多。

现在的实现：

- 首屏文档 + 每份分页 body **分别解析**，再按 activityId 合并（避免多份 RSC 拼接时 chunk id 互相覆盖）。
- 分页 body 由页面内 fetch/XHR 猴补丁 clone 到 `window.__liPagBodies`，抓取端每轮 drain 取走并清空；
  不能用 CDP `response.body()`（会和页面自身抢 body，报 "No data found"，整页静默丢失）。
- 滚动改为小步（0.35 屏）+ wheel 事件；停的条件是“分页里最早一条帖子早于 72h 窗口起点”，
  不再按轮数猜；滚到底 / 连续 3 轮没响应也会停。首屏文档默认是“热门”序、可能夹着很早的旧帖，
  所以不参与停止判断，只用于补首屏帖子。
- 排序控件下拉的“最新”文案实际是“最近搜索”，按 最近/最新/Recent 匹配。
- `activityIdsFromRsc` 在 root 解析不到 feed items 时回退 `activityIdsInOrder`，并与 root 结果取并集。
- `interface_mode` 日志之前把诊断字段写在 extra 顶层（`ScrapeLogExtra` 只认 `context`），库里一直是 `{}`；
  现在写入 `context`，包含 rscActivityIds / rscBodies / paginationBodies / docBytes / httpStatus 等。
- 回归：`pnpm run li:pag`（假 page + 虚拟时钟，覆盖正常分页、滚到底、请求无响应、首屏已过窗口）。

已知差异：新版 RSC 路径不产出正文，`text` 为空（参考项目 `linkedin-rsc.ts` 同样不解析正文）。

### LinkedIn 卡片来源（2026-10-30 事故结论）

原来本项目的帖子主来源是 DOM 里 `data-urn` 上的 activityId，GraphQL/RSC 只靠 `window.fetch` 猴补丁抓，
而参考项目的主来源是 `page.on("response")` 拿 voyager GraphQL。

- 项目跑了 5 天，`interface_mode` 689 条全是 `dom`，GraphQL/RSC 一次都没生效。
- 10-30 08:00 LinkedIn 改了公司动态页 DOM，`data-urn` 消失，于是 19/19 全失败，参考项目不受影响。

修复：

- GraphQL 改用 `page.on("response")` + `response.json()`（与 `linkedin-network.ts` 同路），猴补丁降级为备。
- DOM 兜底改用 `.feed-shared-update-v2 / div[role="article"]` 选卡片，activityId 从属性 + 链接 + 文案正则兜底提取。
- `interface_mode` 日志新增 `apiResponses / apiBodies / rscBodies / apiSampleUrls`，下次可直接判断是没抓到还是解析不出来。

### LinkedIn sdui 首屏文档（2026-10-31 同步参考项目 `0b24248`）

参考项目 2026-10-31 00:25 的 `fix: 修复linkedin rsc解析` 指出：公司动态已经改成 **sdui SSR 随首屏文档下发**，
不再发 `rsc-action/actions/pagination` 分页请求，页面上也没有可用的 DOM 卡片外层。

| 参考项目改动 | 本项目 |
|---|---|
| `activityIdsFromRsc` 找不到根 chunk `0` 时回退 `activityIdsInOrder(text)` | 已同步（原来直接 `return []`，这是 10-30 全挂的直接原因） |
| `activityIdsInOrder` 过滤长度 < 15 的截断编号 | 已同步 |
| 首屏文档 `\"` 反转义后再解析 | 已同步 |
| 首屏文档参与 activityId 收集与去重 | 本项目本来就把 `docText` 拼进 RSC 文本，现在才真正解析得出来 |
| 探测阶段把「首屏文档里有 activityId」判定为 rsc | 本项目按解析结果判定，同步后自然命中 |

snowflake 时间戳已用真实数据核对：`7521179981826310146 → 2026-10-28 20:04 (UTC+8)`，
与库里同批次帖子 `published_ts_ms` 一致，新格式编号位布局没变。

## 数据口径

- LinkedIn 的 `次展示` 不再写入 `reads`，也不写 `likes`；语义未确认，只保留在 `raw_json`。
- LinkedIn 历史点赞无法从旧 `raw_json` 回填。
- 历史 68 条 LinkedIn `reads` 已清空。
- Facebook adaptive 类型账号没有播放量来源，`views` 写 `null`，报表上会和“0 播放”区分开。

## 验证状态

- Facebook：语法检查、adapter import 通过；本地未登录，未做真实账号回归。
- Facebook fixture 回归（`pnpm run fb:parse`）：adaptive 抓包 3 条帖子，赞/评/转 = 8/0/0、118/1/1、140/1/1，播放量为空；classic 抓包 229 条帖子，reel 播放量 12231 / 1233437 / 15073 与改动前一致。
- Facebook 首屏重试回归（`pnpm run fb:retry`）：卡死后重载恢复、重试耗尽、关闭重试、无提示超时、接口有帖子但 DOM 无卡片 5 个场景全部通过；真实浏览器下的卡死重载仍需在服务器观察 `facebook_retry` 日志。
- LinkedIn：GraphQL fixture 10 条、RSC fixture 10 条解析通过；本地未登录，未做真实账号回归。
- LinkedIn 新版 sdui（2026-10-31，ego 浏览器实测 MG Motor UK 线上页）：首屏文档解析出 3 条帖子，赞/评/转分别 43/1/1、10/2/1、31/0/2；切“最新”后 pagination 第一页解析出 3 条（含 ZS Hybrid+）；再滚一屏解析出 10 条，72h 窗口内 3 条，计数齐全。
- LinkedIn 分页循环回归（`pnpm run li:pag`）：正常分页、滚到底、请求无响应、首屏已过窗口起点 4 个场景通过。
- **待办**：本机 `work/playwright-profile` 的 LinkedIn 登录态已失效（打开公司页返回 HTTP 999、跳登录页），需要重新执行 `pnpm run login --platform linkedin`；登录后跑一轮确认 `interface_mode` 的 `rscActivityIds`/`paginationBodies` 不为 0。
- 代码层面的参考项目差异已按上表处理；真实登录态仍需在 Windows 服务器回归。
