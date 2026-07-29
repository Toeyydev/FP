// Payment worker — a standalone, long-running process for the Railway
// "payment-worker" service. It has NO HTTP server: it wakes on a timer, does a
// bounded unit of work, and sleeps again. It is built by `npm run build:worker`
// (esbuild bundle → dist/worker/payment-worker.js) and started by `npm run worker`.
// It never runs `next build`, so route module-graph evaluation can't fail it.
//
// What it does: drains PaymentEvidence rows that already carry extracted `rawText`
// but haven't been parsed yet (processingStatus = QUEUED). Each row is parsed by the
// shared, pure extractFromText() into a PaymentTransaction. Text extraction itself
// (PDF-text / OCR) is intentionally NOT here — that dependency isn't chosen yet, and
// the parser is the reusable, testable core. Once OCR is wired at upload time (or a
// future stage populates rawText), this worker turns that text into structured
// transactions without any code change here.
//
// Design rules honoured:
//   - No DB connection, query, or external client at import time — everything the
//     module touches at load is side-effect-free. The Prisma client in @/lib/db is
//     lazy; @/lib/crypto is now lazy too.
//   - Every DB call is wrapped in try/catch, so the worker starts and idles cleanly
//     even before the add_payment_evidence migration has been applied.
//   - SIGTERM / SIGINT drain the in-flight tick, disconnect Prisma, then exit(0) —
//     Railway sends SIGTERM on redeploy/scale-down.

import { prisma } from "@/lib/db";
import { extractFromText } from "@/lib/payments/slip-evidence";

const POLL_INTERVAL_MS = Number(process.env.PAYMENT_WORKER_POLL_MS ?? 15_000);
const BATCH_SIZE = Number(process.env.PAYMENT_WORKER_BATCH ?? 10);
// Master switch. Set PAYMENT_WORKER_ENABLED=false to run the process as a pure
// heartbeat (useful to deploy the service before the feature is meant to act).
const ENABLED = (process.env.PAYMENT_WORKER_ENABLED ?? "true").toLowerCase() !== "false";

let shuttingDown = false;
let ticking = false;

function log(msg: string, extra?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), svc: "payment-worker", msg, ...extra };
  console.log(JSON.stringify(line));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One unit of work: claim up to BATCH_SIZE queued evidence rows that already have
 * rawText, and parse each into a PaymentTransaction. Returns how many were handled.
 * All DB access is guarded — a missing table / unapplied migration logs once and
 * yields 0 rather than crashing the process.
 */
async function processQueuedBatch(): Promise<number> {
  let rows: Array<{ id: string; rawText: string | null; extractionMethod: string | null }> = [];
  try {
    rows = await prisma.paymentEvidence.findMany({
      where: { processingStatus: "QUEUED", rawText: { not: null } },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
      select: { id: true, rawText: true, extractionMethod: true },
    });
  } catch (err) {
    log("queue-read-skipped (table missing or DB unavailable)", { error: String(err) });
    return 0;
  }

  if (!rows.length) return 0;

  let handled = 0;
  for (const row of rows) {
    if (shuttingDown) break;
    if (!row.rawText) continue;
    try {
      await extractFromText({
        evidenceId: row.id,
        extractedText: row.rawText,
        extractionMethod: row.extractionMethod ?? "WORKER_TEXT",
        actorId: null,
        actorRole: "SYSTEM_WORKER",
      });
      handled++;
    } catch (err) {
      log("extract-failed", { evidenceId: row.id, error: String(err) });
      // Best-effort: flag the row so a bad slip doesn't jam the queue forever.
      try {
        await prisma.paymentEvidence.update({
          where: { id: row.id },
          data: { processingStatus: "FAILED", processingError: String(err).slice(0, 1000) },
        });
      } catch {
        /* swallow — we already logged the real error */
      }
    }
  }
  return handled;
}

async function tick(): Promise<void> {
  if (ticking || shuttingDown) return;
  ticking = true;
  try {
    const n = await processQueuedBatch();
    if (n > 0) log("batch-processed", { count: n });
  } catch (err) {
    log("tick-error", { error: String(err) });
  } finally {
    ticking = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown-start", { signal });
  // Let an in-flight tick finish (bounded wait) before disconnecting.
  for (let i = 0; i < 100 && ticking; i++) await sleep(50);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  log("shutdown-complete", { signal });
  process.exit(0);
}

async function main(): Promise<void> {
  log("worker-start", {
    enabled: ENABLED,
    pollMs: POLL_INTERVAL_MS,
    batch: BATCH_SIZE,
    node: process.version,
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Never let a stray rejection kill the loop.
  process.on("unhandledRejection", (reason) => log("unhandledRejection", { reason: String(reason) }));

  // Continuous loop, no HTTP server. Keeps the process alive on Railway.
  while (!shuttingDown) {
    if (ENABLED) {
      await tick();
    } else {
      log("heartbeat (disabled)");
    }
    // Sleep in small slices so shutdown is responsive.
    const until = POLL_INTERVAL_MS;
    for (let waited = 0; waited < until && !shuttingDown; waited += 250) {
      await sleep(Math.min(250, until - waited));
    }
  }
}

main().catch((err) => {
  log("fatal", { error: String(err) });
  process.exit(1);
});
