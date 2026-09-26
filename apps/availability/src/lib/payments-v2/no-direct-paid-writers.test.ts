import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The Phase 1 invariant, guarded by the repository itself: a job becomes PAID only through
// lib/payments-v2. This test reads the source and fails if a new writer appears, so the rule
// cannot be lost to a future edit that looks harmless in review.

const SRC = join(process.cwd(), "src");
const files: string[] = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    // Tests are excluded, integration tests included: a fixture that creates a PAID
    // row is how the paid branch gets exercised, not a production writer.
    else if (/\.tsx?$/.test(entry) && !/\.i?test\.tsx?$/.test(entry)) files.push(p);
  }
})(SRC);
const rel = (p: string) => p.slice(SRC.length + 1);

/** Every `prisma.tourPayment.<write>(…)` call in the file, with the arguments that follow it. */
function tourPaymentWrites(text: string): string[] {
  const out: string[] = [];
  const re = /tourPayment\.(upsert|update|updateMany|create|createMany)\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0, i = re.lastIndex - 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") { depth--; if (depth === 0) break; }
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

describe("repository invariant — only payments-v2 can make a job PAID", () => {
  it("no file outside lib/payments-v2 writes TourPayment.status = PAID", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file).startsWith("lib/payments-v2/")) continue; // the canonical writer
      for (const call of tourPaymentWrites(readFileSync(file, "utf8"))) {
        // A `where: { status: "PAID" }` reads; only a write inside data/create/update counts.
        const writesPaid = /(?:data|create|update)\s*:\s*\{[^}]*status\s*:\s*["']PAID["']/s.test(call);
        if (writesPaid) offenders.push(`${rel(file)}: ${call.replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the files that mention status PAID at all are the known ones, each for a reading or a non-status write", () => {
    const mentions = files.filter((f) => /status\s*:\s*["']PAID["']/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(mentions).toEqual([
      // Counts paid batches for the dashboard — a filter.
      "app/api/dashboard/route.ts",
      // Reads a paid transfer back to describe it — no write.
      "app/api/pay/peak-document/pay/route.ts",
      // Record EXP writes only peakRef, on rows already paid (a filter).
      "app/api/pay/route.ts",
      // Legacy batch undo reverts rows this batch paid (a filter); it cannot pay.
      "app/api/payment-batches/route.ts",
      // Lists this month's paid tours for the PEAK reference view.
      "app/api/peak/status/route.ts",
      // Skips cancelling a job that was already paid (a filter).
      "lib/booking-import.ts",
      // Takes a wrongly attached slip off a legacy PAID row: PAID only in the guard
      // (`where`), and the write sets PENDING. It can un-pay, never pay.
      "lib/payment-slip-correction.ts",
      // The canonical writer.
      "lib/payments-v2/service.ts",
      // The two-stage PEAK document's own status, not a job's.
      "lib/peak-payment-document.ts",
      // Document status, plus lock/stamp queries on already-paid jobs.
      "lib/peak-payment-server.ts",
    ]);
  });

  it("no route decides payment ownership from the TourPayment cache pointer alone", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file).startsWith("lib/payments-v2/")) continue; // the service owns both sides
      const text = readFileSync(file, "utf8");
      if (!/guidePaymentId/.test(text)) continue;
      // Reading it to display is fine; using it to decide needs GuidePaymentJob in the file.
      const decides = /guidePaymentId\s*:\s*\{\s*not\s*:\s*null|guidePaymentId\s*!==?\s*null|\.guidePaymentId\s*\?/.test(text);
      if (decides && !/guidePaymentJob/i.test(text)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});
