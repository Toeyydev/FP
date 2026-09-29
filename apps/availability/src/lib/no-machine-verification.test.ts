import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Nothing in FolkOPS reads a bank slip.
//
// `lib/kbiz-slip` parses text a bank hands over; it has never seen an image, and no OCR
// dependency is installed. The amount and the reference on a transfer are TYPED by an
// operator looking at the slip, and the record says exactly that:
//
//   USER_VERIFIED_SLIP · ตรวจสอบโดยผู้ใช้งานจากสลิป
//
// So the screen must never say "OCR verified" or "Bank verified". Those claim a machine
// or a bank confirmed the figure, and an auditor reading them would believe the company
// holds evidence it does not have. This test keeps that promise in the repository, where
// a future edit has to argue with it rather than quietly reword a label.

const SRC = join(process.cwd(), "src");
const files: string[] = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry) && !/\.i?test\.tsx?$/.test(entry)) files.push(p);
  }
})(SRC);
const rel = (p: string) => p.slice(SRC.length + 1);

const FORBIDDEN = [
  /\bOCR[\s-]?verified\b/i,
  /\bbank[\s-]?verified\b/i,
  /\bverified\s+by\s+(the\s+)?bank\b/i,
  /\bautomatically\s+verified\b/i,
];

describe("a person verified the slip, and nothing claims otherwise", () => {
  it("no file says a machine or a bank verified a transfer", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const re of FORBIDDEN) {
        const m = text.match(re);
        if (m) offenders.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(
      offenders,
      "The amount and the bank reference are typed by a person reading the slip. Say ตรวจสอบโดยผู้ใช้งานจากสลิป (USER_VERIFIED_SLIP), never that a machine or a bank confirmed it:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("no OCR library has quietly appeared in the dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    // If one is ever added deliberately, this test is the place to record the decision.
    expect(names.filter((n) => /tesseract|ocr|textract|vision/i.test(n))).toEqual([]);
  });
});
