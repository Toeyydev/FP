// Which advance build this is. The ledger cutover has to tell builds apart from the
// outside — /api/health reports it, and every database connection carries it as its
// Postgres application_name, so pg_stat_activity can prove no older instance is still
// connected (and so cannot still be writing) before the migration runs.
export const ADVANCE_BUILD = "compat" as const;
export const DB_APPLICATION_NAME = `folkops-${ADVANCE_BUILD}`;

/** DATABASE_URL with application_name set, unless the URL already names one. */
export function withApplicationName(url: string | undefined, name: string = DB_APPLICATION_NAME): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("application_name")) u.searchParams.set("application_name", name);
    return u.toString();
  } catch {
    return url; // not a URL we can read: leave it exactly as configured
  }
}
