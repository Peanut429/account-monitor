import { useRouter } from "@tanstack/react-router";

export function RefreshButton({ label = "刷新" }: { label?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn"
      onClick={() => {
        void router.invalidate();
      }}
    >
      {label}
    </button>
  );
}
