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

## 验证状态

- Facebook：语法检查、adapter import 通过；本地未登录，未做真实账号回归。
- LinkedIn：GraphQL fixture 10 条、RSC fixture 10 条解析通过；本地未登录，未做真实账号回归。
- 代码层面的参考项目差异已按上表处理；真实登录态仍需在 Windows 服务器回归。
