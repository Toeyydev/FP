// A user is "online" if we've heard from them in the last 3 minutes (the app
// heartbeats every ~60s). Pure helpers — usable on server and client.
export const ONLINE_WINDOW_MS = 3 * 60 * 1000;

export function isOnline(lastSeenAt: string | Date | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const t = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  return Number.isFinite(t) && Date.now() - t < ONLINE_WINDOW_MS;
}

// "online" / "5m ago" / "2h ago" / "3d ago" / "—"
export function lastSeenLabel(lastSeenAt: string | Date | null | undefined): string {
  if (!lastSeenAt) return "—";
  const t = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < ONLINE_WINDOW_MS) return "online";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
