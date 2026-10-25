const META: Record<string, { label: string; className: string }> = {
  success: { label: "成功", className: "status-success" },
  failed: { label: "失败", className: "status-failed" },
  running: { label: "运行中", className: "status-running" },
  partial_failed: { label: "部分失败", className: "status-partial" },
  cancelled: { label: "已取消", className: "status-idle" },
};

export function StatusBadge({
  status,
  error,
}: {
  status?: string | null;
  error?: string | null;
}) {
  if (!status) {
    return <span className="status-badge status-idle">未抓取</span>;
  }
  const meta = META[status] || { label: status, className: "status-idle" };
  return (
    <span className={`status-badge ${meta.className}`} title={error || undefined}>
      {meta.label}
    </span>
  );
}
