import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "~/components/EmptyState";
import { RefreshButton } from "~/components/RefreshButton";
import {
  deltaClass,
  formatDelta,
  formatFullTs,
  formatNumber,
  formatRelative,
  formatTs,
  truncate,
} from "~/lib/format";
import { fetchAccountPosts } from "~/server/queries";

export const Route = createFileRoute("/accounts/$accountId/")({
  validateSearch: (search: Record<string, unknown>) => ({
    scope: search.scope === "all" ? ("all" as const) : ("72h" as const),
  }),
  loaderDeps: ({ search }) => ({ scope: search.scope }),
  loader: async ({ params, deps }) => (
    fetchAccountPosts({ data: { accountId: params.accountId, scope: deps.scope } })
  ),
  component: AccountPostsPage,
});

function AccountPostsPage() {
  const posts = Route.useLoaderData();
  const { scope } = Route.useSearch();
  const { accountId } = Route.useParams();

  return (
    <div>
      <div className="section-head">
        <div>
          <h2 className="section-title">帖子</h2>
          <div className="section-sub">
            {scope === "72h" ? "按发布时间过滤，只看近 72 小时" : "全部历史帖子（最多 500 条）"}
            {" · "}
            {posts.length} 条
          </div>
        </div>
        <div className="page-actions">
          <div className="tabs">
            <Link
              to="/accounts/$accountId"
              params={{ accountId }}
              search={{ scope: "72h" }}
              className={`tab ${scope === "72h" ? "active" : ""}`}
            >
              近 72 小时
            </Link>
            <Link
              to="/accounts/$accountId"
              params={{ accountId }}
              search={{ scope: "all" }}
              className={`tab ${scope === "all" ? "active" : ""}`}
            >
              全部历史
            </Link>
          </div>
          <RefreshButton />
        </div>
      </div>

      <div className="card table-card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>发布时间</th>
                <th>类型</th>
                <th>内容</th>
                <th className="num">播放/阅读</th>
                <th className="num">点赞</th>
                <th className="num">评论</th>
                <th className="num">转发</th>
                <th className="num">快照</th>
                <th>最近抓取</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => {
                const likeDelta = post.latest.likes != null && post.first.likes != null
                  ? post.latest.likes - post.first.likes
                  : null;
                const publishedTs = post.publishedTsMs ?? post.firstSeenTsMs;
                return (
                  <tr key={post.id}>
                    <td title={formatFullTs(publishedTs)} className="num" style={{ textAlign: "left" }}>
                      {formatTs(publishedTs)}
                    </td>
                    <td><span className="tag">{post.contentType || "post"}</span></td>
                    <td className="content-cell">
                      <Link
                        to="/accounts/$accountId/posts/$postId"
                        params={{ accountId, postId: post.id }}
                        className="content-snippet"
                      >
                        {truncate(post.title || post.text) || "(无正文)"}
                      </Link>
                    </td>
                    <td className="num">{formatNumber(post.latest.views ?? post.latest.reads)}</td>
                    <td className="num">
                      {formatNumber(post.latest.likes)}
                      {likeDelta != null && likeDelta !== 0 ? (
                        <span className={deltaClass(likeDelta)} style={{ marginLeft: 6, fontSize: 11 }}>
                          {formatDelta(likeDelta)}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{formatNumber(post.latest.comments)}</td>
                    <td className="num">{formatNumber(post.latest.shares)}</td>
                    <td className="num">{formatNumber(post.snapshotCount)}</td>
                    <td title={formatFullTs(post.latestCapturedTsMs)}>
                      {post.latestCapturedTsMs ? formatRelative(post.latestCapturedTsMs) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {posts.length === 0 ? (
          <EmptyState
            title={scope === "72h" ? "这个账号近 72 小时没有帖子" : "这个账号还没有帖子记录"}
            description={
              scope === "72h"
                ? "监控窗口是执行时刻往前 72 小时。发帖频率低的账号出现空列表是正常的。"
                : "等监控跑过几轮，或者确认账号主页链接是否正确。"
            }
          />
        ) : null}
      </div>

      <div className="list-note">
        “快照”是这个帖子目前入库的指标记录数。每小时抓一次、帖子一直在 72 小时窗口内时，
        最完整大约 72 条；实际会受发布时间、失败周期、账号刚加入监控等因素影响。
      </div>
    </div>
  );
}
