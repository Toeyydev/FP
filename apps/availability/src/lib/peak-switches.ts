// The two PEAK switches, as BOTH services hold them.
//
//   PEAK_ADVANCE_AUTO_SYNC=1               the worker posts advance journals to PEAK
//   ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1  an admin records documents PEAK already holds
//
// The two must never be on together: the sender would create a document for a movement
// while an admin records that the accountant's document already is that movement — two
// documents for one transfer. And they are set PER SERVICE: FP (the web app, which links)
// and payment-worker (which posts) each read their own environment and cannot read the
// other's. One service's switch says nothing about the other's, so a screen that reads
// "automatic posting is ON" from FP alone can be wrong in the way that matters.
//
// So each service writes what it holds to ServiceStatus (recordServiceStatus), and every
// decision reads both (evaluatePeakSafety):
//
//   UNSAFE    a service has both on, or the sender is on in one service while linking
//             is on in the other. Nothing is posted, nothing is linked, and no new
//             accounting entry is written (refuseAccountingWrite). Reads stay open.
//   MISMATCH  the two services hold different switches. Red on screen; the worker does
//             not post and an admin does not link until they agree.
//   UNKNOWN   the worker has not reported recently. Linking needs the worker's own word
//             that its sender is off, so it is refused; the worker itself still follows
//             its own switches.
//
// Nothing here ever changes a Railway variable: the screen says which ones to set.
import type { PrismaClient } from "@prisma/client";
import { advanceAutoSyncEnabled, advanceWritesFrozen, existingPeakLinksEnabled } from "@/lib/advances/freeze";

export type ServiceName = "FP" | "payment-worker";

export type Switches = { autoSync: boolean; existingLinks: boolean; writesFrozen: boolean };

/** This process's own switches. */
export const localSwitches = (): Switches => ({ autoSync: advanceAutoSyncEnabled(), existingLinks: existingPeakLinksEnabled(), writesFrozen: advanceWritesFrozen() });

/** Both on in one environment — refused everywhere, whatever the other service says. */
export const switchesUnsafe = (s: Pick<Switches, "autoSync" | "existingLinks">) => s.autoSync && s.existingLinks;

export const UNSAFE_LOCAL_MESSAGE =
  "PEAK_ADVANCE_AUTO_SYNC and ADVANCE_EXISTING_PEAK_LINKS_ENABLED are both 1 on this service. Nothing is posted or linked until one is set to 0.";

/** A report older than this is not evidence of anything. The worker reports every minute. */
export const STATUS_STALE_MS = 5 * 60_000;
/** How often a service rewrites its row when nothing changed. */
export const STATUS_EVERY_MS = 60_000;

export type ServiceReport = Switches & {
  service: ServiceName; version: string | null; deploymentId: string | null;
  startedAt: string; lastSeenAt: string; lastSuccessAt: string | null; lastError: string | null;
};

export type SafetyState = "AUTO" | "LINKS" | "OFF" | "UNSAFE" | "MISMATCH" | "UNKNOWN";

export type SafetyIssue = { code: "UNSAFE_FP" | "UNSAFE_WORKER" | "UNSAFE_ACROSS" | "MISMATCH" | "WORKER_SILENT" | "VERSION_DIFFERS"; th: string; en: string; fix: string };

export type PeakSafety = {
  state: SafetyState;
  fp: ServiceReport;
  worker: (ServiceReport & { stale: boolean }) | null;
  issues: SafetyIssue[];
  /** The worker may post (its own switches and FP's, when FP has reported, agree). */
  postingAllowed: boolean;
  /** An admin may record an existing PEAK document right now. */
  linkingAllowed: boolean;
  /** New advances, settlements, allocations and reversals may be written. */
  accountingWritesAllowed: boolean;
  checkedAt: string;
};

const ENV_FIX_AUTO = "Set PEAK_ADVANCE_AUTO_SYNC=1 and ADVANCE_EXISTING_PEAK_LINKS_ENABLED=0 on BOTH FP and payment-worker";
const ENV_FIX_LINKS = "Set PEAK_ADVANCE_AUTO_SYNC=0 and ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1 on BOTH FP and payment-worker";

/**
 * The combined state of the two services. Pure: what each reported, and the time.
 * A worker report older than STATUS_STALE_MS counts as no report.
 */
export function evaluatePeakSafety(fp: ServiceReport, workerRow: ServiceReport | null, nowMs: number): PeakSafety {
  const stale = !workerRow || nowMs - Date.parse(workerRow.lastSeenAt) > STATUS_STALE_MS;
  const worker = workerRow ? { ...workerRow, stale } : null;
  const live = worker && !stale ? worker : null;
  const issues: SafetyIssue[] = [];

  if (switchesUnsafe(fp)) issues.push({ code: "UNSAFE_FP", th: "FP เปิด auto-sync และ existing-links พร้อมกัน", en: "FP has automatic posting AND existing-document links on at once.", fix: "On FP, set one of the two to 0 (usually ADVANCE_EXISTING_PEAK_LINKS_ENABLED=0)." });
  if (live && switchesUnsafe(live)) issues.push({ code: "UNSAFE_WORKER", th: "payment-worker เปิด auto-sync และ existing-links พร้อมกัน", en: "payment-worker has automatic posting AND existing-document links on at once.", fix: "On payment-worker, set one of the two to 0." });
  if (live && ((fp.existingLinks && live.autoSync) || (fp.autoSync && live.existingLinks)) && !switchesUnsafe(fp) && !switchesUnsafe(live)) {
    issues.push({ code: "UNSAFE_ACROSS", th: "service หนึ่งส่ง PEAK อัตโนมัติ ขณะที่อีก service เปิดการผูกเอกสารเดิม", en: "One service posts to PEAK automatically while the other lets an admin link existing documents.", fix: `Make both services agree — ${ENV_FIX_AUTO} (normal), or ${ENV_FIX_LINKS} (while reconciling).` });
  }
  const mismatch = !!live && (live.autoSync !== fp.autoSync || live.existingLinks !== fp.existingLinks || live.writesFrozen !== fp.writesFrozen);
  if (mismatch) issues.push({ code: "MISMATCH", th: "ค่า switch ของ FP กับ payment-worker ไม่ตรงกัน", en: "FP and payment-worker hold different PEAK switches.", fix: `Set the same values on both: ${ENV_FIX_AUTO} (normal), or ${ENV_FIX_LINKS} (while reconciling).` });
  if (!live) issues.push({ code: "WORKER_SILENT", th: worker ? "payment-worker ไม่ได้รายงานสถานะมาเกิน 5 นาที" : "ยังไม่มีรายงานสถานะจาก payment-worker", en: worker ? "payment-worker has not reported for more than 5 minutes." : "payment-worker has not reported its status yet.", fix: "Check that the payment-worker service is running on Railway (deploy logs)." });
  if (live && fp.version && live.version && fp.version !== live.version) issues.push({ code: "VERSION_DIFFERS", th: "FP กับ payment-worker รันคนละเวอร์ชัน", en: "FP and payment-worker are running different versions.", fix: "Wait for both deploys to finish; redeploy the one that is behind." });

  const unsafe = issues.some((i) => i.code.startsWith("UNSAFE"));
  const state: SafetyState = unsafe ? "UNSAFE" : mismatch ? "MISMATCH" : !live ? "UNKNOWN"
    : fp.autoSync ? "AUTO" : fp.existingLinks ? "LINKS" : "OFF";
  return {
    state, fp, worker, issues,
    postingAllowed: !unsafe && !mismatch && !!live && live.autoSync && !live.existingLinks && !live.writesFrozen,
    linkingAllowed: !unsafe && !mismatch && !!live && fp.existingLinks && !fp.autoSync && !live.autoSync,
    accountingWritesAllowed: !unsafe,
    checkedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * The worker's own question, asked before every batch: may I post? Its own switches
 * first; then FP's last report, when FP has reported recently — an FP that is linking,
 * or that disagrees, stops the sender. A silent FP does not (the worker cannot wait on a
 * web page being opened); linking then needs the worker's report, so the two can still
 * never act on one movement at once.
 */
export function workerMayPost(own: Switches, fpRow: ServiceReport | null, nowMs: number): { ok: true } | { ok: false; code: string; message: string } {
  if (!own.autoSync) return { ok: false, code: "AUTO_SYNC_OFF", message: "PEAK_ADVANCE_AUTO_SYNC is not 1 on payment-worker" };
  if (switchesUnsafe(own)) return { ok: false, code: "UNSAFE_LOCAL", message: UNSAFE_LOCAL_MESSAGE };
  if (own.writesFrozen) return { ok: false, code: "FROZEN", message: "ADVANCE_WRITES_FROZEN is 1" };
  const fpLive = fpRow && nowMs - Date.parse(fpRow.lastSeenAt) <= STATUS_STALE_MS ? fpRow : null;
  if (fpLive && fpLive.existingLinks) return { ok: false, code: "UNSAFE_ACROSS", message: "FP has ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1 — an admin may be linking existing documents" };
  if (fpLive && !fpLive.autoSync) return { ok: false, code: "MISMATCH", message: "FP has PEAK_ADVANCE_AUTO_SYNC=0 while payment-worker has 1 — set the same on both" };
  return { ok: true };
}

const processStartedAt = new Date();
const runtimeVersion = () => process.env.RAILWAY_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_BUILD_ID || null;

type StatusDb = Pick<PrismaClient, "serviceStatus">;

const toReport = (r: { id: string; version: string | null; deploymentId: string | null; autoSync: boolean; existingLinks: boolean; writesFrozen: boolean; startedAt: Date; lastSeenAt: Date; lastSuccessAt: Date | null; lastError: string | null }): ServiceReport => ({
  service: r.id as ServiceName, version: r.version, deploymentId: r.deploymentId, autoSync: r.autoSync, existingLinks: r.existingLinks, writesFrozen: r.writesFrozen,
  startedAt: r.startedAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null, lastError: r.lastError,
});

/** This process, as it would report itself right now. */
export function selfReport(service: ServiceName, nowMs: number = Date.now()): ServiceReport {
  const s = localSwitches();
  return { service, ...s, version: runtimeVersion(), deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null, startedAt: processStartedAt.toISOString(), lastSeenAt: new Date(nowMs).toISOString(), lastSuccessAt: null, lastError: null };
}

let lastWritten: { at: number; key: string } | null = null;
let lastSuccessWritten: number | null = null;

/** An error as a service may report it: no URL (a connection string carries credentials), short. */
export const scrub = (msg: string) => msg.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Write this service's row: at most once a minute, or at once when something changed.
 * Best-effort — reporting must never stop the work it describes.
 */
export async function recordServiceStatus(db: StatusDb, service: ServiceName, extra: { success?: boolean; error?: string | null } = {}, nowMs: number = Date.now()): Promise<void> {
  const me = selfReport(service, nowMs);
  const key = JSON.stringify([me.autoSync, me.existingLinks, me.writesFrozen, me.version, extra.error ?? null]);
  // A success is its own news: the plain report at the start of a pass must not swallow the
  // success at its end, or "last successful run" is never written.
  const successDue = !!extra.success && (!lastSuccessWritten || nowMs - lastSuccessWritten >= STATUS_EVERY_MS);
  if (!successDue && lastWritten && lastWritten.key === key && nowMs - lastWritten.at < STATUS_EVERY_MS) return;
  const at = new Date(nowMs);
  const data = {
    version: me.version, deploymentId: me.deploymentId, autoSync: me.autoSync, existingLinks: me.existingLinks, writesFrozen: me.writesFrozen,
    startedAt: processStartedAt, lastSeenAt: at,
    ...(extra.success ? { lastSuccessAt: at, lastError: null } : {}),
    ...(extra.error ? { lastError: scrub(extra.error) } : {}),
  };
  if (!db.serviceStatus?.upsert) return;
  try {
    await db.serviceStatus.upsert({ where: { id: service }, create: { id: service, ...data }, update: data });
    lastWritten = { at: nowMs, key };
    if (extra.success) lastSuccessWritten = nowMs;
  } catch { /* the table may not exist yet during a deploy; next pass tries again */ }
}

export async function readServiceReport(db: StatusDb, service: ServiceName): Promise<ServiceReport | null> {
  if (!db.serviceStatus?.findUnique) return null; // a deliberately small test facade
  const r = await db.serviceStatus.findUnique({ where: { id: service } }).catch(() => null);
  return r ? toReport(r) : null;
}

/** The combined state, as FP sees it: its own switches live, the worker's from its last report. */
export async function readPeakSafety(db: StatusDb, nowMs: number = Date.now()): Promise<PeakSafety> {
  await recordServiceStatus(db, "FP", {}, nowMs);
  return evaluatePeakSafety(selfReport("FP", nowMs), await readServiceReport(db, "payment-worker"), nowMs);
}

export const UNSAFE_WRITE_MESSAGE_TH = "ระบบหยุดบันทึกรายการบัญชีใหม่ชั่วคราว เพราะสวิตช์ PEAK อยู่ในสถานะไม่ปลอดภัย (ดูแถบสถานะ PEAK บนหน้า Payments → Advances)";
export const UNSAFE_WRITE_MESSAGE_EN = "New accounting entries are paused: the PEAK switches are in an unsafe combination (see the PEAK status bar on Payments → Advances). Reading is not affected.";

/** The refusal an accounting write answers with while the switches are unsafe (HTTP 503). */
export function unsafeWriteBody(safety: PeakSafety) {
  const reasons = [UNSAFE_WRITE_MESSAGE_TH, UNSAFE_WRITE_MESSAGE_EN, ...safety.issues.filter((i) => i.code.startsWith("UNSAFE")).map((i) => `${i.en} ${i.fix}`)];
  return { error: "peak-switches-unsafe", code: "PEAK_SWITCHES_UNSAFE", reasons, detail: reasons.join("\n"), hint: UNSAFE_WRITE_MESSAGE_EN };
}
