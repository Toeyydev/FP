import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A review incentive is paid ONE way: inside the guide's payment document, under its
// FOLK-PAY number, where it is booked to 510110 and withheld on at 3% like the fee.
//
// A second path was designed once (a standalone ReviewPayout, numbered FOLK-RR-…, on
// its own weekly run) and never merged — PR #72 has been open since August. Nothing
// in the running system creates one: no model, no table in production, no audit row.
// That is the state this test pins. It is not asking anyone to remove something; it
// is here so the day that branch, or one like it, is merged, the build says what the
// rule is instead of the money quietly leaving without its tax.
//
// The rule, in the words the screen should use:
//
//   ค่าตอบแทนรีวิวไกด์ต้องรวมในเอกสารจ่ายเงินไกด์ FOLK-PAY เพื่อคำนวณภาษีหัก ณ ที่จ่าย 3%
//
// Reading and showing the history of any rows that already exist stays allowed. What
// is refused is creating, approving or paying a NEW one outside FOLK-PAY.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const files: string[] = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry) && !/\.i?test\.tsx?$/.test(entry)) files.push(p);
  }
})(SRC);
const rel = (p: string) => p.slice(SRC.length + 1);

const POLICY = "ค่าตอบแทนรีวิวไกด์ต้องรวมในเอกสารจ่ายเงินไกด์ FOLK-PAY เพื่อคำนวณภาษีหัก ณ ที่จ่าย 3%";

describe("a review incentive is paid only inside FOLK-PAY", () => {
  it("nothing writes a standalone review payout", () => {
    const writes = /reviewPayout\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    const offenders = files
      .filter((f) => writes.test(readFileSync(f, "utf8")))
      .map((f) => rel(f));
    expect(offenders, `${POLICY}\n\nThese files create or change a ReviewPayout outside the payment document:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("nothing mints a FOLK-RR number", () => {
    // A number is minted, not merely mentioned: a template literal or a string that
    // builds the ref. Comments and historical notes are left alone.
    const mint = /["'`]FOLK-RR-\$\{|["'`]FOLK-RR-["'`]\s*\+|`FOLK-RR-\$/;
    const offenders = files.filter((f) => mint.test(readFileSync(f, "utf8"))).map((f) => rel(f));
    expect(offenders, `${POLICY}\n\nThese files generate a FOLK-RR reference:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the schema has no ReviewPayout model to pay from", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    expect(/^model\s+ReviewPayout\b/m.test(schema), POLICY).toBe(false);
  });
});
