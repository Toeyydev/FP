// The gate in front of APPLY for the settlement-marker restore tool (scripts/restore-settlement-markers).
//
// Pure apart from one injected read of the app's /api/health, so every way it can refuse is
// testable without a network or a real database. It FAILS CLOSED: anything missing, unknown,
// malformed, slow or unhealthy refuses. Only an explicit, recognised "frozen" from a healthy
// app lets a remote apply through — never a truthy/falsy guess.

export type ApplyRequest = {
  apply: boolean; production: boolean;
  expectDatabase: string; expectSystemId: string; operator: string; healthUrl: string;
  frozenInProcess: string | undefined;          // this tool process's ADVANCE_WRITES_FROZEN
};
export type DatabaseIdentity = { db: string; sysid: string; local: boolean };
export type HealthRead = (url: string) => Promise<{ status: number; body: unknown } | { error: string }>;
export type GateResult = { ok: true } | { ok: false; reason: string };

const HEALTH_URL = /^https:\/\/[^/\s]+\/api\/health$/;
const HEALTH_TIMEOUT_MS = 5000;

/** The real read: GET only, a short timeout, never throws. */
export const fetchHealth: HealthRead = async (url) => {
  try {
    const r = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  } catch (e) {
    return { error: (e as Error)?.name === "TimeoutError" ? "timed out" : "unreachable" };
  }
};

/** Does this health answer say, explicitly, that advance writes are frozen? Unknown is NO. */
export function healthSaysFrozen(read: { status: number; body: unknown } | { error: string }): GateResult {
  if ("error" in read) return { ok: false, reason: `the app's health could not be read (${read.error})` };
  if (!(read.status >= 200 && read.status < 300)) return { ok: false, reason: `the app's health answered HTTP ${read.status}` };
  const b = read.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return { ok: false, reason: "the app's health answer is not a JSON object" };
  const body = b as Record<string, unknown>;
  if (body.ok !== true) return { ok: false, reason: `the app does not report itself healthy (ok = ${JSON.stringify(body.ok ?? null)})` };
  const adv = body.advances;
  if (adv === null || typeof adv !== "object" || Array.isArray(adv)) return { ok: false, reason: "the app's health does not report the advance-writes state" };
  const writes = (adv as Record<string, unknown>).writes;
  if (writes === "frozen") return { ok: true };
  if (writes === "active" || writes === "enabled" || writes === "open") return { ok: false, reason: `the app reports advance writes ${writes} — freeze them first` };
  return { ok: false, reason: `the app reports advance writes as ${JSON.stringify(writes ?? null)}, not "frozen"` };
}

/**
 * Every condition for APPLY, in one place. Dry runs pass straight through. The health read is
 * made only for a remote database, and only after every local condition holds.
 */
export async function applyGate(req: ApplyRequest, id: DatabaseIdentity, readHealth: HealthRead = fetchHealth): Promise<GateResult> {
  if (!req.apply) return { ok: true };
  if (!id.db || !id.sysid) return { ok: false, reason: "could not prove which database this is (no name or system identifier)" };
  if (req.expectDatabase !== id.db) return { ok: false, reason: `--expect-database must be exactly "${id.db}" (the database this connects to)` };
  if (req.expectSystemId !== id.sysid) return { ok: false, reason: `--expect-system-id must be exactly "${id.sysid}" (this database's cluster)` };
  if (!req.operator.trim()) return { ok: false, reason: "--operator is required: who is running this goes in the audit log" };
  if (req.frozenInProcess !== "1") return { ok: false, reason: "ADVANCE_WRITES_FROZEN=1 is required in this process — markers are restored only while writes are frozen" };
  if (id.local) return { ok: true };
  if (!req.production) return { ok: false, reason: "this database is not on this machine — add --production to say you mean it" };
  if (!HEALTH_URL.test(req.healthUrl)) return { ok: false, reason: "--health-url https://<app>/api/health is required for a remote database" };
  const health = healthSaysFrozen(await readHealth(req.healthUrl));
  return health.ok ? { ok: true } : { ok: false, reason: `${health.reason} (${req.healthUrl})` };
}
