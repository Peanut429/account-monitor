import { createFileRoute, Link, notFound, Outlet, useRouterState } from "@tanstack/react-router";
import { MetricCard } from "~/components/MetricCard";
import { PlatformBadge } from "~/components/PlatformBadge";
import { RefreshButton } from "~/components/RefreshButton";
import { StatusBadge } from "~/components/StatusBadge";
import { formatFullTs, formatNumber, formatRelative } from "~/lib/format";
import { fetchAccount } from "~/server/queries";

export const Route = createFileRoute("/accounts/$accountId")({
  loader: async ({ params }) => {
    const account = await fetchAccount({ data: { accountId: params.accountId } });
    if (!account) throw notFound();
    return account;
  },
  component: AccountLayout,
});

function AccountLayout() {
  const account = Route.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // 帖子详情页自己带面包屑和帖子头，不再重复账号头。
  if (/\/posts\//.test(pathname)) {
    return <Outlet />;
  }

  return (
    <div>
      <div className="breadcrumbs">
        <Link to="/">账号总览</Link>
        <span>/</span>
        <span>{account.handle}</span>
      </div>

      <div className="card detail-head">
        <div className="detail-top">
          <div>
            <div className="detail-title">
              <PlatformBadge code={account.platformCode} />
              <span>{account.displayName || account.handle}</span>
              <StatusBadge status={account.lastRunStatus} error={account.lastRunErrorMessage} />
            </div>
            <div className="detail-meta">
              <span>@{account.handle}</span>
              <span>{account.platformName}</span>
              {account.accountType ? <span>{account.accountType}</span> : null}
              <a className="text-link" href={account.profileUrl} target="_blank" rel="noreferrer">
                主页 ↗
              </a>
            </div>
          </div>
          <div className="page-actions">
            <RefreshButton />
          </div>
        </div>

        <div className="metric-strip">
          <MetricCard
            label="粉丝"
            value={formatNumber(account.followers)}
            sub="最近一次账号快照"
          />
          <MetricCard
            label="关注"
            value={formatNumber(account.following)}
            sub="最近一次账号快照"
          />
          <MetricCard
            label="帖子总数"
            value={formatNumber(account.postsCount)}
            sub="平台侧可见总数"
          />
          <MetricCard
            label="账号指标抓取"
            value={account.metricsCapturedTsMs ? formatRelative(account.metricsCapturedTsMs) : "—"}
            sub={formatFullTs(account.metricsCapturedTsMs)}
          />
        </div>
      </div>

      {account.lastRunStatus === "failed" ? (
        <div className="banner banner-error">
          最近一次抓取失败：{account.lastRunErrorCode || "SCRAPE_FAILED"}
          {account.lastRunErrorMessage ? ` · ${account.lastRunErrorMessage}` : ""}
        </div>
      ) : null}

      <Outlet />
    </div>
  );
}
