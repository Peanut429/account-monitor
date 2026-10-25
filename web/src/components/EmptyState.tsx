export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-desc">{description}</div> : null}
    </div>
  );
}
