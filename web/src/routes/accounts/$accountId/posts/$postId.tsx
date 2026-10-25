import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { EmptyState } from "~/components/EmptyState";
import { LineChart } from "~/components/LineChart";
import { MetricCard } from "~/components/MetricCard";
import { PlatformBadge } from "~/components/PlatformBadge";
import { RefreshButton } from "~/components/RefreshButton";
import { StatusBadge } from "~/components/StatusBadge";
import {
  deltaClass,
  formatDelta,
  formatFullTs,
  formatInterval,
  formatNumber,
  formatRelative,
  formatTs,
} from "~/lib/format";
import { fetchPost } from "~/server/queries";

export const Route = createFileRoute("/accounts/$accountId/posts/$postId")({
  loader: async ({ params }) => {
    const post = await fetchPost({
      data: { accountId: params.accountId, postId: params.postId },
    });
    if (!post) throw notFound();
    return post;
  },
  component: PostDetailPage,
});

function PostDetailPage() {
  const post = Route.useLoaderData();
  const { accountId } = Route.useParams();
  const snapshots = [...post.snapshots].sort((a, b) => a.capturedTsMs - b.capturedTsMs);

  const rows = snapshots.map((snapshot, index) => {
    const previous = index > 0 ? snapshots[index - 1] : null;
    return {
      ...snapshot,
      intervalMs: previous ? snapshot.capturedTsMs - previous.capturedTsMs : null,
      likesDelta: previous && snapshot.likes != null && previous.likes != null
        ? snapshot.likes - previous.likes
        : null,
      commentsDelta: previous && snapshot.comments != null && previous.comments != null
        ? snapshot.comments - previous.comments
        : null,
    };
  });

  const gaps = rows.filter((row) => row.intervalMs != null && row.intervalMs > 90 * 60_000);
  const latest = snapshots[snapshots.length - 1] || null;
  const first = snapshots[0] || null;
  const publishedTs = post.publishedTsMs ?? post.firstSeenTsMs;
  const totalLikesDelta = latest && first && latest.likes != null && first.likes != null
    ? latest.likes - first.likes
    : null;

  const exportCsv = () => {
    const header = ["captured_at", "views", "likes", "comments", "shares", "saves", "reads", "run_status"];
    const lines = snapshots.map((snapshot) => [
      formatFullTs(snapshot.capturedTsMs),
      snapshot.views ?? "",
      snapshot.likes ?? "",
      snapshot.comments ?? "",
      snapshot.shares ?? "",
      snapshot.saves ?? "",
      snapshot.reads ?? "",
      snapshot.runStatus,
    ].join(","));
    const blob = new Blob([`\uFEFF${[header.join(","), ...lines].join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${post.id}-snapshots.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="breadcrumbs">
        <Link to="/">账号总览</Link>
        <span>/</span>
        <Link to="/accounts/$accountId" params={{ accountId }}>
          {post.handle}
        </Link>
        <span>/</span>
        <span>帖子</span>
      </div>

      <div className="card detail-head">
        <div className="detail-top">
          <div>
            <div className="detail-title">
              <PlatformBadge code={post.platformCode} />
              <span>{post.title || post.contentType || "帖子"}</span>
              {latest ? <StatusBadge status={latest.runStatus} error={latest.runError} /> : null}
            </div>
            <div className="detail-meta">
              <span>@{post.handle}</span>
              <span>发布 {formatFullTs(publishedTs)}</span>
              <a className="text-link" href={post.url} target="_blank" rel="noreferrer">
                原帖 ↗
              </a>
            </div>
          </div>
          <div className="page-actions">
            <button type="button" className="btn" onClick={exportCsv} disabled={!snapshots.length}>
              导出 CSV
            </button>
            <RefreshButton />
          </div>
        </div>

        <div className="metric-strip">
          <MetricCard
            label="最新播放 / 阅读"
            value={formatNumber(latest?.views ?? latest?.reads)}
            sub={latest ? formatRelative(latest.capturedTsMs) : "还没有快照"}
          />
          <MetricCard
            label="最新点赞"
            value={formatNumber(latest?.likes)}
            sub={totalLikesDelta != null ? `较首次 ${formatDelta(totalLikesDelta)}` : "—"}
          />
          <MetricCard
            label="最新评论"
            value={formatNumber(latest?.comments)}
            sub={latest ? formatRelative(latest.capturedTsMs) : "—"}
          />
          <MetricCard
            label="抓取记录"
            value={formatNumber(snapshots.length)}
            sub="最完整约 72 条"
          />
        </div>
      </div>

      <div className="card post-body">
        <p className={post.text ? "post-text" : "post-text empty-text"}>
          {post.text || (post.title ? "该平台没有返回正文，标题见上方。" : "这条帖子没有抓到正文/标题。")}
        </p>
        <div className="detail-meta" style={{ marginTop: 10 }}>
          <span>首次发现 {formatFullTs(post.firstSeenTsMs)}</span>
          <span>最后发现 {formatFullTs(post.lastSeenTsMs)}</span>
          <span>{post.contentType || "post"}</span>
        </div>
      </div>

      {snapshots.length ? (
        <div className="chart-grid">
          <LineChart
            title="播放 / 阅读"
            points={snapshots.map((snapshot) => ({
              ts: snapshot.capturedTsMs,
              value: snapshot.views ?? snapshot.reads,
            }))}
          />
          <LineChart
            title="点赞"
            points={snapshots.map((snapshot) => ({ ts: snapshot.capturedTsMs, value: snapshot.likes }))}
            color="#e11d48"
          />
          <LineChart
            title="评论"
            points={snapshots.map((snapshot) => ({ ts: snapshot.capturedTsMs, value: snapshot.comments }))}
            color="#7c3aed"
          />
          <LineChart
            title="转发 / 分享"
            points={snapshots.map((snapshot) => ({ ts: snapshot.capturedTsMs, value: snapshot.shares }))}
            color="#0891b2"
          />
        </div>
      ) : null}

      <div className="section-head">
        <div>
          <h2 className="section-title">抓取记录</h2>
          <div className="section-sub">
            {snapshots.length} 条快照
            {snapshots.length ? ` · ${formatTs(snapshots[0].capturedTsMs)} → ${formatTs(snapshots[snapshots.length - 1].capturedTsMs)}` : ""}
          </div>
        </div>
        <RefreshButton />
      </div>

      {gaps.length ? (
        <div className="banner">
          有 {gaps.length} 个抓取间隔超过 1.5 小时
          {gaps.length ? `（最近：${gaps.slice(-5).map((row) => formatFullTs(row.capturedTsMs)).join("、")}）` : ""}。
          可能是抓取失败、上一轮未结束、账号刚加入监控，或帖子当时不在 72h 窗口内。
        </div>
      ) : null}

      <div className="card table-card">
        <div className="table-wrap snapshot-wrap">
          <table className="data snapshot-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>抓取时间</th>
                <th>间隔</th>
                <th className="num">播放/阅读</th>
                <th className="num">点赞</th>
                <th className="num">评论</th>
                <th className="num">转发</th>
                <th className="num">收藏</th>
                <th className="num">点赞变化</th>
                <th>任务</th>
                <th>原始</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id}>
                  <td className="num">{index + 1}</td>
                  <td title={formatFullTs(row.capturedTsMs)}>{formatFullTs(row.capturedTsMs)}</td>
                  <td>{formatInterval(row.intervalMs)}</td>
                  <td className="num">{formatNumber(row.views ?? row.reads)}</td>
                  <td className="num">{formatNumber(row.likes)}</td>
                  <td className="num">{formatNumber(row.comments)}</td>
                  <td className="num">{formatNumber(row.shares)}</td>
                  <td className="num">{formatNumber(row.saves)}</td>
                  <td className={`num ${deltaClass(row.likesDelta)}`}>{formatDelta(row.likesDelta)}</td>
                  <td><StatusBadge status={row.runStatus} error={row.runError} /></td>
                  <td>
                    <details>
                      <summary>查看</summary>
                      <pre className="raw-json">{JSON.stringify(row.rawJson, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title="还没有抓取记录"
            description="这篇帖子还没有进入过任何一轮监控，或者该轮抓取失败了。"
          />
        ) : null}
      </div>

      <div className="list-note">
        正常情况下，一篇帖子在 72 小时窗口内每小时一条记录，最完整约 72 条。
        实际条数会受发布时间、账号加入监控的时间、抓取失败和平台时间精度影响；
        如果明显少于预期，先看对应周期的任务状态。
      </div>
    </div>
  );
}
