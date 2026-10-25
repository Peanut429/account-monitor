import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "~/components/EmptyState";
import { PlatformBadge } from "~/components/PlatformBadge";
import { RefreshButton } from "~/components/RefreshButton";
import { StatusBadge } from "~/components/StatusBadge";
import { formatFullTs, formatNumber, formatRelative, formatTs } from "~/lib/format";
import { fetchAccounts, fetchOverview } from "~/server/queries";

export const Route = createFileRoute("/")({
  loader: async () => {
    const [overview, accounts] = await Promise.all([fetchOverview(), fetchAccounts()]);
    return { overview, accounts };
  },
  component: AccountsPage,
});

function AccountsPage() {
  const { overview, accounts } = Route.useLoaderData();
  const [platform, setPlatform] = useState("all");
  const [query, setQuery] = useState("");

  const platforms = overview.platforms.filter((item) => item.accounts > 0);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return accounts.filter((account) => {
      if (platform !== "all" && account.platformCode !== platform) return false;
      if (!keyword) return true;
      return `${account.handle} ${account.displayName || ""}`.toLowerCase().includes(keyword);
    });
  }, [accounts, platform, query]);

  const latestCycle = overview.latestCycle;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">账号总览</h1>
          <div className="page-sub">
            6 个平台 · {overview.accounts} 个欧洲账号 · 每次抓取近 72 小时
          </div>
        </div>
        <div className="page-actions">
          <RefreshButton />
        </div>
      </div>

      <div className="kpi-grid">
        <div className="card kpi">
          <div className="kpi-label">监控账号</div>
          <div className="kpi-value">{formatNumber(overview.accounts)}</div>
          <div className="kpi-sub">{platforms.length} 个平台有账号</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">近 72h 帖子</div>
          <div className="kpi-value">{formatNumber(overview.posts72h)}</div>
          <div className="kpi-sub">{formatNumber(overview.snapshots72h)} 条指标快照</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">近 72h 抓取任务</div>
          <div className="kpi-value">{formatNumber(overview.runs72h)}</div>
          <div className="kpi-sub">
            {overview.failedRuns72h > 0 ? `${overview.failedRuns72h} 个失败` : "没有失败"}
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">最近周期</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>
            {latestCycle ? <StatusBadge status={latestCycle.status} /> : "—"}
          </div>
          <div className="kpi-sub">
            {latestCycle
              ? `${formatRelative(latestCycle.startedTsMs)} · ${latestCycle.successRuns}/${latestCycle.totalRuns} 成功`
              : "还没有监控周期"}
          </div>
        </div>
      </div>

      {!latestCycle ? (
        <div className="banner banner-info">
          还没有监控数据。先在项目根目录跑一轮 <code>pnpm run monitor</code>，这里就会出现账号和帖子。
        </div>
      ) : latestCycle.failedRuns > 0 ? (
        <div className="banner banner-error">
          最近周期有 {latestCycle.failedRuns} 个账号失败（开始于 {formatFullTs(latestCycle.startedTsMs)}）。
          点进账号看具体错误，常见原因是登录态失效。
        </div>
      ) : null}

      <div className="toolbar">
        <div className="chips">
          <button
            type="button"
            className={`chip ${platform === "all" ? "active" : ""}`}
            onClick={() => setPlatform("all")}
          >
            全部
          </button>
          {platforms.map((item) => (
            <button
              key={item.code}
              type="button"
              className={`chip ${platform === item.code ? "active" : ""}`}
              onClick={() => setPlatform(item.code)}
            >
              {item.name} {item.accounts}
            </button>
          ))}
        </div>
        <input
          className="search"
          placeholder="搜索 handle / 账号名"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="card table-card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>平台</th>
                <th>账号</th>
                <th className="num">粉丝</th>
                <th className="num">帖子数</th>
                <th className="num">近 72h 帖子</th>
                <th className="num">近 72h 快照</th>
                <th>最近抓取</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((account) => (
                <tr key={account.id}>
                  <td><PlatformBadge code={account.platformCode} /></td>
                  <td>
                    <div className="account-cell">
                      <Link
                        to="/accounts/$accountId"
                        params={{ accountId: account.id }}
                        className="account-handle"
                      >
                        {account.handle}
                      </Link>
                      <span className="account-name">
                        {account.displayName || "—"}
                        {" · "}
                        <a
                          className="text-link"
                          href={account.profileUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          主页 ↗
                        </a>
                      </span>
                    </div>
                  </td>
                  <td className="num">{formatNumber(account.followers)}</td>
                  <td className="num">{formatNumber(account.postsCount)}</td>
                  <td className="num">
                    {account.posts72h > 0
                      ? <span className="tag">{formatNumber(account.posts72h)}</span>
                      : <span className="muted">0</span>}
                  </td>
                  <td className="num">{formatNumber(account.snapshots72h)}</td>
                  <td title={formatFullTs(account.lastRunFinishedTsMs)}>
                    {account.lastRunFinishedTsMs
                      ? formatRelative(account.lastRunFinishedTsMs)
                      : <span className="muted">未抓取</span>}
                  </td>
                  <td>
                    <StatusBadge
                      status={account.lastRunStatus}
                      error={account.lastRunErrorMessage}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的账号"
            description="换个平台筛选或搜索词试试。"
          />
        ) : null}
      </div>

      {latestCycle ? (
        <div className="footer-note">
          最近周期窗口：{formatTs(latestCycle.windowStartTsMs)} → {formatTs(latestCycle.windowEndTsMs)}
          {" · "}
          开始于 {formatFullTs(latestCycle.startedTsMs)}
        </div>
      ) : null}
    </div>
  );
}
