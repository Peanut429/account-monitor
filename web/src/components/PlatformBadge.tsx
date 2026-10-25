const META: Record<string, { label: string; className: string }> = {
  x: { label: "X", className: "platform-x" },
  youtube: { label: "YouTube", className: "platform-youtube" },
  instagram: { label: "Instagram", className: "platform-instagram" },
  facebook: { label: "Facebook", className: "platform-facebook" },
  linkedin: { label: "LinkedIn", className: "platform-linkedin" },
  tiktok: { label: "TikTok", className: "platform-tiktok" },
};

export function PlatformBadge({ code }: { code: string }) {
  const meta = META[code] || { label: code, className: "platform-other" };
  return <span className={`platform-badge ${meta.className}`}>{meta.label}</span>;
}
