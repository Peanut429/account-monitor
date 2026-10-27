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

## LinkedIn

参考入口：`linkedin-auto.ts` -> `linkedin-network.ts` / `linkedin-rsc.ts`

| 参考项目 | 当前实现 | 状态 |
|---|---|---|
| `linkedin-rsc-parser.ts` | 原样复制 | 已对齐 |
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
| checkpoint / Excel / CLI | 本项目不需要 | 不适用 |

## 数据口径

- LinkedIn 的 `次展示` 不再写入 `reads`，也不写 `likes`；语义未确认，只保留在 `raw_json`。
- LinkedIn 历史点赞无法从旧 `raw_json` 回填。
- 历史 68 条 LinkedIn `reads` 已清空。
- Facebook adaptive 类型账号没有播放量来源，`views` 写 `null`，报表上会和“0 播放”区分开。

## 验证状态

- Facebook：语法检查、adapter import 通过；本地未登录，未做真实账号回归。
- Facebook fixture 回归（`pnpm run fb:parse`）：adaptive 抓包 3 条帖子，赞/评/转 = 8/0/0、118/1/1、140/1/1，播放量为空；classic 抓包 229 条帖子，reel 播放量 12231 / 1233437 / 15073 与改动前一致。
- LinkedIn：GraphQL fixture 10 条、RSC fixture 10 条解析通过；本地未登录，未做真实账号回归。
- 代码层面的参考项目差异已按上表处理；真实登录态仍需在 Windows 服务器回归。
