import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Repository invariant, the same shape as the one that keeps PAID inside payments-v2:
// the two running totals may only be moved by the ledger service, in one conditional
// statement. A counter written anywhere else could pass every unit test and still drift
// from the ledger it is supposed to summarise.
const ROOT = join(process.cwd(), "src");
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) files.push(p);
  }
})(ROOT);

const rel = (p: string) => p.slice(ROOT.length + 1);
/** Comments explain the rule; they are not writes. Strip them before scanning. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const LEDGER = "lib/advances/service.ts";

describe("repository invariant — only the ledger moves its counters", () => {
  it("no file outside lib/advances/service writes settledSatang or allocatedSatang", () => {
    const offenders = files.filter((p) => {
      if (rel(p) === LEDGER || /\.test\.tsx?$/.test(p)) return false;
      const src = code(readFileSync(p, "utf8"));
      // A WRITE, not a read: the counter given a value (Prisma `data:`), assigned to,
      // or moved by raw SQL. `settledSatang: true` in a select and `: number` in a type
      // are reads and are fine.
      // …inside a Prisma `data:` object. Passing the value to a function is a read.
      const written = /\bdata\s*:\s*\{[^}]*(?<![A-Za-z])(settledSatang|allocatedSatang)\s*:/.test(src);
      const assigned = /(?<![A-Za-z])(settledSatang|allocatedSatang)\s*=[^=]/.test(src);
      const rawSql = /UPDATE\s+"Guide(Advance|AdvanceReceipt)"/i.test(src);
      return written || assigned || rawSql;
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("the ledger changes a counter only with a bounded conditional update", () => {
    const src = readFileSync(join(ROOT, LEDGER), "utf8");
    const updates = src.match(/UPDATE "Guide(Advance|AdvanceReceipt)"[\s\S]*?`/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(3);
    for (const u of updates) {
      expect(u).toMatch(/>= 0/);
      expect(u).toMatch(/<= "(amountSatang)"/);
    }
  });

  it("a payment's advance settlement is written inside the payment transaction", () => {
    const src = readFileSync(join(ROOT, "lib/payments-v2/service.ts"), "utf8");
    expect(src).toContain("applyDeductionsInTx(tx,");
    expect(src).toContain("reverseDeductionsForPaymentInTx(tx,");
  });
});
