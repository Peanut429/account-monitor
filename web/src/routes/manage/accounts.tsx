import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { EmptyState } from "~/components/EmptyState";
import { PlatformBadge } from "~/components/PlatformBadge";
import { RefreshButton } from "~/components/RefreshButton";
import { StatusBadge } from "~/components/StatusBadge";
import { formatNumber, formatRelative } from "~/lib/format";
import type { ManagedAccount, PlatformOption } from "~/lib/types";
import {
  createManagedAccount,
  fetchAccountManagement,
  setManagedAccountActive,
} from "~/server/queries";

export const Route = createFileRoute("/manage/accounts")({
  loader: () => fetchAccountManagement(),
  component: ManageAccountsPage,
});

const PROFILE_PLACEHOLDERS: Record<string, string> = {
  x: "https://x.com/品牌名",
  youtube: "https://www.youtube.com/@品牌名",
  instagram: "https://www.instagram.com/品牌名/",
  facebook: "https://www.facebook.com/品牌名/",
  linkedin: "https://www.linkedin.com/company/品牌名/posts/",
  tiktok: "https://www.tiktok.com/@品牌名",
};

function ManageAccountsPage() {
  const { accounts, platforms } = Route.useLoaderData();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const activeCount = accounts.filter((account) => account.active).length;
  const inactiveCount = accounts.length - activeCount;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return accounts.filter((account) => {
      if (platform !== "all" && account.platformCode !== platform) return false;
      if (status === "active" && !account.active) return false;
      if (status === "inactive" && account.active) return false;
      if (!keyword) return true;
      return `${account.handle} ${account.displayName || ""}`.toLowerCase().includes(keyword);
    });
  }, [accounts, platform, query, status]);

  const toggleActive = async (account: ManagedAccount) => {
    setBusyId(account.id);
    setMessage(null);
    try {
      await setManagedAccountActive({
        data: { accountId: account.id, active: !account.active },
      });
      setMessage({
        type: "success",
        text: `已${account.active ? "停用" : "启用"} ${account.handle}。${account.active ? "下一轮开始不再抓取，历史数据保留。" : "下一轮开始抓取。"}`,
      });
      await router.invalidate();
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleCreated = async (handle: string) => {
    setShowAdd(false);
    setMessage({ type: "success", text: `已添加 ${handle}，下一轮监控会开始处理。` });
    await router.invalidate();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">账号管理</h1>
          <div className="page-sub">
            启用 / 停用账号，或添加新的主页链接。停用不会删除历史数据。
          </div>
        </div>
        <div className="page-actions">
          <RefreshButton />
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            添加账号
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="card kpi">
          <div className="kpi-label">全部账号</div>
          <div className="kpi-value">{formatNumber(accounts.length)}</div>
          <div className="kpi-sub">{platforms.length} 个平台</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">启用中</div>
          <div className="kpi-value">{formatNumber(activeCount)}</div>
          <div className="kpi-sub">账号状态为启用</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">已停用</div>
          <div className="kpi-value">{formatNumber(inactiveCount)}</div>
          <div className="kpi-sub">历史数据保留</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">当前筛选</div>
          <div className="kpi-value">{formatNumber(filtered.length)}</div>
          <div className="kpi-sub">账号列表里显示的数量</div>
        </div>
      </div>

      {message ? (
        <div className={`banner ${message.type === "success" ? "banner-success" : "banner-error"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="toolbar">
        <div className="chips">
          <button
            type="button"
            className={`chip ${status === "all" ? "active" : ""}`}
            onClick={() => setStatus("all")}
          >
            全部 {accounts.length}
          </button>
          <button
            type="button"
            className={`chip ${status === "active" ? "active" : ""}`}
            onClick={() => setStatus("active")}
          >
            启用 {activeCount}
          </button>
          <button
            type="button"
            className={`chip ${status === "inactive" ? "active" : ""}`}
            onClick={() => setStatus("inactive")}
          >
            停用 {inactiveCount}
          </button>
        </div>
        <div className="toolbar-right">
          <select
            className="input select-compact"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="all">全部平台</option>
            {platforms.map((item) => (
              <option key={item.code} value={item.code}>{item.name}</option>
            ))}
          </select>
          <input
            className="search"
            placeholder="搜索 handle / 账号名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="card table-card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>平台</th>
                <th>账号</th>
                <th>类型</th>
                <th>账号状态</th>
                <th>最近抓取</th>
                <th className="num">近 72h 帖子</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((account) => (
                <tr key={account.id} className={account.active ? "" : "row-inactive"}>
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
                        <a className="text-link" href={account.profileUrl} target="_blank" rel="noreferrer">
                          主页 ↗
                        </a>
                      </span>
                    </div>
                  </td>
                  <td><span className="tag">{account.accountType || "—"}</span></td>
                  <td>
                    <span className={`status-badge ${account.active ? "status-success" : "status-idle"}`}>
                      {account.active ? "已启用" : "已停用"}
                    </span>
                  </td>
                  <td>
                    <div className="account-cell">
                      <StatusBadge status={account.lastRunStatus} error={account.lastRunErrorMessage} />
                      <span className="account-name">
                        {account.lastRunFinishedTsMs
                          ? formatRelative(account.lastRunFinishedTsMs)
                          : "还没有抓取记录"}
                      </span>
                    </div>
                  </td>
                  <td className="num">{formatNumber(account.posts72h)}</td>
                  <td>
                    <button
                      type="button"
                      className={`btn ${account.active ? "" : "btn-primary"}`}
                      disabled={busyId === account.id}
                      onClick={() => void toggleActive(account)}
                    >
                      {busyId === account.id ? "处理中…" : account.active ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的账号"
            description="换个筛选条件，或者点右上角“添加账号”。"
          />
        ) : null}
      </div>

      <div className="list-note">
        停用后，这个账号不再进入新的监控周期，但历史帖子和指标都保留。
        新增或启用后，下一轮监控才会开始抓取；当前正在跑的那一轮不受影响。
        只要账号是启用状态，就会进入下一轮监控；<code>account_type</code> 只是分类标签，不影响是否抓取。
      </div>

      {showAdd ? (
        <AddAccountDialog
          platforms={platforms}
          onClose={() => setShowAdd(false)}
          onCreated={handleCreated}
        />
      ) : null}
    </div>
  );
}

function AddAccountDialog({
  platforms,
  onClose,
  onCreated,
}: {
  platforms: PlatformOption[];
  onClose: () => void;
  onCreated: (handle: string) => Promise<void> | void;
}) {
  const [form, setForm] = useState({
    platformCode: platforms[0]?.code || "x",
    handle: "",
    displayName: "",
    profileUrl: "",
    accountType: "欧洲",
    active: true,
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const setField = (key: keyof typeof form, value: string | boolean) => {
    setForm((previous) => ({ ...previous, [key]: value }) as typeof form);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await createManagedAccount({ data: form });
      await onCreated(form.handle.trim());
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title">
        <div className="modal-head">
          <div>
            <h2 className="section-title" id="add-account-title">添加账号</h2>
            <div className="section-sub">主页链接会直接作为抓取入口，不会用 handle 拼 URL。</div>
          </div>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>关闭</button>
        </div>

        <form onSubmit={submit}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="add-platform">平台</label>
              <select
                id="add-platform"
                className="input"
                value={form.platformCode}
                onChange={(event) => setField("platformCode", event.target.value)}
              >
                {platforms.map((item) => (
                  <option key={item.code} value={item.code}>{item.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="add-handle">账号 / handle</label>
              <input
                id="add-handle"
                className="input"
                value={form.handle}
                onChange={(event) => setField("handle", event.target.value)}
                placeholder="例如 @brand 或 brand"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="add-display-name">显示名称</label>
              <input
                id="add-display-name"
                className="input"
                value={form.displayName}
                onChange={(event) => setField("displayName", event.target.value)}
                placeholder="不填就用 handle"
              />
            </div>

            <div className="field">
              <label htmlFor="add-account-type">账号类型</label>
              <input
                id="add-account-type"
                className="input"
                value={form.accountType}
                onChange={(event) => setField("accountType", event.target.value)}
                placeholder="欧洲"
              />
              <div className="field-help">账号类型只用于分类，不影响是否监控。</div>
            </div>

            <div className="field full">
              <label htmlFor="add-profile-url">主页链接</label>
              <input
                id="add-profile-url"
                className="input"
                type="url"
                value={form.profileUrl}
                onChange={(event) => setField("profileUrl", event.target.value)}
                placeholder={PROFILE_PLACEHOLDERS[form.platformCode] || "https://..."}
                required
              />
              <div className="field-help">必须是完整 http/https 链接，例如平台主页地址。</div>
            </div>

            <label className="checkbox-row full">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => setField("active", event.target.checked)}
              />
              添加后立即启用（下一轮监控开始抓取）
            </label>
          </div>

          {error ? <div className="form-error">{error}</div> : null}

          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "添加中…" : "添加账号"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
