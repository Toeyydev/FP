import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload, certifiableRows, fileHash, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { FONT_STACK, renderCertificateHtml } from "@/lib/certificates/document";
import { pdfRendererAvailable, renderPdf } from "@/lib/certificates/pdf";
import { CHROME_BUILD_ID, findExecutable } from "@/lib/certificates/browser";
import { probeRenderer, resetProbe } from "@/lib/certificates/probe";
import type { Expense } from "@/lib/jobsheet";
import { readBackCount, unmappedGlyphCount } from "@/lib/certificates/text-layer";

// The renderer, against the Chromium the DEPLOYMENT provides.
//
// This is the test the others cannot be. Everything else stubs the render, because a
// browser in a unit test would be slow and beside the point — but then nothing checks
// the thing most likely to break on the day it ships: whether this container has a
// Chromium at all, whether it has a font that can draw Thai, and whether the process it
// starts ever goes away again.
//
// It deliberately does NOT fall back to a browser that happens to be on the machine. A
// Mac with Google Chrome and the system Thai fonts installed will render this
// beautifully and tell you nothing about a Linux container with neither. The browser is
// the one `npm run browser:install` put inside the project, at the build this
// puppeteer-core expects, and CI blanks every override so the runner's own Chrome cannot
// stand in for it.
//
// All data invented — this repo is public.

const FACTS: SheetFacts = {
  jobRef: "FOLK-TEST-20990401-01", tourDate: "2099-04-01", slotIdx: 0,
  guideId: "G-900", guideName: "สมชาย ทดสอบ",
  guideReportedAt: new Date("2099-04-02T06:30:00.000Z"),
};
const row = (description: string, price: number): Expense =>
  ({ description, price, pax: 5, expenseType: "transport", paidBy: "guide", paidBySource: "operator" } as Expense);

const html = () => {
  const payload = buildPayload(FACTS, certifiableRows([row("ค่าเรือข้ามฟาก", 11), row("ค่ารถโดยสาร", 15)]));
  return renderCertificateHtml({
    certificateNo: "CERT-FOLK-TEST-20990401-01-01",
    payload, payloadHash: payloadHash(payload),
    attestedByName: "มาลี ทดสอบ", attestedByRole: "ADMIN",
    attestedAt: "2099-04-03T09:15:00.000Z", auditRef: "cert_test",
  });
};

const ready = pdfRendererAvailable();
// In CI this suite always runs. Skipping is for a developer's laptop, where there is
// nothing meaningful to point it at; a CI run that quietly skipped would be a green
// tick over the one thing nobody else checks.
const describeRenderer = ready || process.env.CI ? describe : describe.skip;

describe("the browser is the project's own", () => {
  it("CI has installed it; a developer's laptop need not have", () => {
    if (process.env.CI) expect(ready, "run `npm run browser:install` — see .github/workflows/ci.yml").toBe(true);
    else if (!ready) console.warn("[renderer] no browser installed — run `npm run browser:install`; CI always does");
  });

  it("comes from the project's managed cache, not from something found on the machine", () => {
    if (!ready) return;
    const exe = findExecutable();
    expect(exe.ok).toBe(true);
    // In CI every override is blanked, so a managed answer is the only possible one.
    if (process.env.CI) expect(exe.ok && exe.source, "CI must use the browser the build installed").toBe("managed");
    expect(exe.ok && exe.path).toContain(CHROME_BUILD_ID);
    expect(exe.ok && exe.path).toContain("chrome-headless-shell");
  });
});

describeRenderer("rendering a Thai certificate with the deployment's own browser", () => {
  it("produces a real PDF, and the hash is of the bytes it produced", async () => {
    const bytes = await renderPdf(html());
    expect(bytes.length).toBeGreaterThan(5_000);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
    const hash = fileHash(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(fileHash(Buffer.from(bytes)));
  }, 60_000);

  it("draws Thai rather than dropping it — the fonts are actually there", async () => {
    const bytes = await renderPdf(html());
    // A PDF that could not find a Thai glyph still lays out boxes, so the file size is
    // not the tell. The embedded font is: a page with no Thai face embedded comes out
    // far smaller and names no font with Thai coverage.
    const raw = bytes.toString("latin1");
    const fonts = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#-]+)/g)].map((m) => m[1]);
    expect(fonts.length, "no font was embedded at all").toBeGreaterThan(0);
    expect(bytes.length, "a page with no Thai face embedded is much smaller than this").toBeGreaterThan(20_000);
  }, 60_000);

  it("renders the same bytes twice — nothing in the page varies between runs", async () => {
    const [a, b] = [await renderPdf(html()), await renderPdf(html())];
    // PDF writers stamp an id and a creation date, so the bytes differ by design. What
    // must not differ is the content stream, which is what the page actually says.
    const content = (buf: Buffer) => buf.toString("latin1").replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, "").replace(/\/ID\s*\[[^\]]*\]/g, "");
    expect(content(a).length).toBe(content(b).length);
  }, 90_000);

  it("closes every browser it starts", async () => {
    const count = () => {
      try { return execFileSync("bash", ["-lc", "pgrep -fc 'chrome|chromium' || true"], { encoding: "utf8" }).trim(); }
      catch { return "0"; }
    };
    const before = Number(count());
    await renderPdf(html());
    await new Promise((r) => setTimeout(r, 1500));
    const after = Number(count());
    expect(after, `left ${after - before} browser process(es) behind`).toBeLessThanOrEqual(before);
  }, 90_000);

  it("renders one at a time, and all of them finish", async () => {
    const results = await Promise.all([renderPdf(html()), renderPdf(html()), renderPdf(html())]);
    for (const b of results) expect(b.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 180_000);

  it("the probe agrees, and says ready for the right reason", async () => {
    resetProbe();
    const p = await probeRenderer({ force: true });
    expect(p.status).toBe("ready");
    expect(p.code).toBe("ok");
    expect(p.ms).toBeGreaterThan(0);
  }, 60_000);

  it("fetches nothing — a page that tries to reach out still renders, without it", async () => {
    const withRemote = html().replace("</body>", `<img src="https://127.0.0.1:9/should-never-load.png"><link rel="stylesheet" href="file:///etc/hosts"></body>`);
    const bytes = await renderPdf(withRemote);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 60_000);
});

// The text layer — what a viewer searches and copies, not what it draws.
//
// The first real Thai certificate looked right and read "บริษัริ ษัท" in Chrome's viewer:
// Noto Sans Thai lifts a tone mark over an upper vowel with a glyph that maps to no
// character, and PDFium prints the /ActualText span and the glyphs both. These run where
// the deployment's fonts are — CI installs them exactly as nixpacks.toml does.

const commandWorks = (cmd: string, args: string[]) => {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
};
const hasUmpush = () => {
  try { return /umpush/i.test(execFileSync("fc-list", [":", "family"], { encoding: "utf8" })); } catch { return false; }
};
const hasPdftotext = commandWorks("pdftotext", ["-v"]);
const hasNoto = () => {
  try { return /Noto Sans Thai/i.test(execFileSync("fc-list", [":", "family"], { encoding: "utf8" })); } catch { return false; }
};

// Every mark position Thai has: upper vowels, lower vowels, tone marks stacked on both,
// thanthakhat, and sara am (which the shaper splits into two glyphs).
const THAI_ROWS: Expense[] = [
  { description: "น้ำดื่ม", price: 10, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" } as Expense,
  { description: "ก๋วยเตี๋ยว", price: 50, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" } as Expense,
  { description: "ค่ารถตุ๊กตุ๊ก", price: 15, pax: 2, expenseType: "transport", paidBy: "guide", paidBySource: "operator" } as Expense,
];
const thaiHtml = (rows: Expense[] = THAI_ROWS) => {
  const payload = buildPayload({ ...FACTS, jobRef: "FOLK-TEST-20990401-02", guideName: "ศรีสุดา ผู้ทดสอบ" }, certifiableRows(rows));
  return renderCertificateHtml({
    certificateNo: "CERT-FOLK-TEST-20990401-02-01",
    payload, payloadHash: payloadHash(payload),
    attestedByName: "มาลี ทดสอบ", attestedByRole: "ADMIN",
    attestedAt: "2099-04-03T09:15:00.000Z", auditRef: "cert_test",
  });
};
/** Visible text of the HTML, as a reader should get it back. Tags and style dropped, entities decoded. */
const visibleText = (html: string) => html
  .replace(/<style[\s\S]*?<\/style>/g, "").replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#96;/g, "`").replace(/&amp;/g, "&");
// Line breaks land between any two Thai letters (Thai has no spaces between words), so
// compare with all whitespace removed.
const squash = (s: string) => s.replace(/\s+/g, "");
const pdftotext = (bytes: Buffer, page?: number, layout = false) =>
  execFileSync("pdftotext", ["-enc", "UTF-8", ...(layout ? ["-layout"] : []), ...(page ? ["-f", String(page), "-l", String(page)] : []), "-", "-"], { input: bytes, encoding: "utf8" });
const pageCount = (bytes: Buffer) => Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", ["-"], { input: bytes, encoding: "utf8" }))?.[1] ?? 0);
// Enough rows to push the attestation onto a second page.
const LONG_ROWS: Expense[] = Array.from({ length: 30 }, (_, i) =>
  ({ description: `${["น้ำดื่ม", "ก๋วยเตี๋ยว", "ค่ารถตุ๊กตุ๊ก"][i % 3]} ชุดที่ ${String(i + 1).padStart(2, "0")}`, price: 10 + i, pax: 2, expenseType: i % 3 === 2 ? "transport" : "meal", paidBy: "guide", paidBySource: "operator" } as Expense));
/** A well-formed PDF with the certificate's Thai face inside it. */
const expectWholePdf = (bytes: Buffer) => {
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
  // /BaseFont for a TrueType or CID font, /FontName in the descriptor of a Type 3 one —
  // which is how Chromium on macOS embeds an OpenType (CFF) face.
  expect(bytes.toString("latin1"), "the certificate's Thai face").toMatch(/\/(BaseFont|FontName)\s*\/[A-Z]{6}\+Umpush/);
};
/** CI keeps the bytes it rendered, so the PDF can be looked at in real viewers. */
const keepSample = (name: string, bytes: Buffer) => {
  const dir = (process.env.CERT_SAMPLE_DIR ?? "").trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
};
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describeRenderer("the text layer reads back as the page reads", () => {
  it("every glyph maps to a character — nothing left for a viewer to guess at", async () => {
    if (!hasUmpush()) {
      if (process.env.CI) throw new Error("Umpush (fonts-thai-tlwg) is not installed — the certificate's Thai face");
      return void console.warn("[renderer] Umpush not installed here — the text-layer check runs in CI");
    }
    const bytes = await renderPdf(thaiHtml());
    keepSample("certificate-1-page.pdf", bytes);
    expectWholePdf(bytes);
    expect(unmappedGlyphCount(bytes), "glyphs that map to U+0000").toBe(0);
  }, 60_000);

  it("pdftotext gets every Thai phrase back once, in order — none doubled, none missing", async () => {
    if (!hasPdftotext || !hasUmpush()) {
      if (process.env.CI) throw new Error("pdftotext (poppler-utils) and Umpush are both installed in CI");
      return void console.warn("[renderer] pdftotext or Umpush missing here — runs in CI");
    }
    const html = thaiHtml();
    const bytes = await renderPdf(html);
    const text = pdftotext(bytes);
    expect(text).not.toContain("\u0000");
    const got = squash(text);
    const want = squash(visibleText(html));

    for (const phrase of [
      "บริษัท", "ใบรับรองแทนใบเสร็จรับเงิน", "ผู้สำรองจ่าย", "น้ำดื่ม", "ก๋วยเตี๋ยว", "ค่ารถตุ๊กตุ๊ก", "ศรีสุดาผู้ทดสอบ",
      "ใบกำกับภาษี", "เครดิตภาษีซื้อ", "สิทธิ์", "อิเล็กทรอนิกส์", "กุญแจส่วนตัว", "ลายนิ้วมือข้อมูลต้นทาง",
      "หนึ่งร้อยห้าสิบบาทถ้วน", "(รอบที่2)", "ค่าอาหารและเครื่องดื่ม", "ค่าพาหนะ",
    ]) {
      expect(count(want, phrase), `"${phrase}" is on the page`).toBeGreaterThan(0);
      expect(count(got, phrase), `"${phrase}" read back`).toBe(count(want, phrase));
    }
    // Whole sentences, so a cluster that came back twice or not at all cannot hide
    // between the phrases above.
    for (const sentence of [
      "บริษัทขอรับรองว่าค่าใช้จ่ายตามรายการข้างล่างนี้เกิดขึ้นจริงในการปฏิบัติงานนำเที่ยวตามใบงานที่อ้างถึงโดยไกด์เป็นผู้สำรองจ่ายไปก่อนและบริษัทมีหน้าที่ต้องจ่ายคืน",
      "ไกด์ไม่ต้องลงนามในเอกสารนี้",
    ]) expect(count(got, sentence), sentence).toBe(1);
    expect(got).not.toContain("รอบที่0");
    expect(got).not.toMatch(/(^|[^a-z])(meal|transport)([^a-z]|$)/);
  }, 60_000);

  it("a two-page certificate is right on both pages — each read back on its own", async () => {
    if (!hasPdftotext || !hasUmpush()) {
      if (process.env.CI) throw new Error("pdftotext (poppler-utils) and Umpush are both installed in CI");
      return void console.warn("[renderer] pdftotext or Umpush missing here — runs in CI");
    }
    const html = thaiHtml(LONG_ROWS);
    const bytes = await renderPdf(html);
    keepSample("certificate-2-pages.pdf", bytes);
    expectWholePdf(bytes);
    expect(pageCount(bytes)).toBe(2);
    expect(unmappedGlyphCount(bytes), "glyphs that map to U+0000").toBe(0);

    const [one, two] = [squash(pdftotext(bytes, 1)), squash(pdftotext(bytes, 2))];
    expect(one).toContain("ใบรับรองแทนใบเสร็จรับเงิน");
    expect(one).toContain("(รอบที่2)");
    // The attestation never splits, and here it is pushed whole onto page two.
    expect(two).toContain("รับรองเอกสารทางอิเล็กทรอนิกส์");
    expect(two).toContain("ไกด์ไม่ต้องลงนามในเอกสารนี้");
    // Every row comes back exactly once across the two pages — none lost at the break,
    // none printed on both sides of it.
    const both = one + two;
    for (const r of LONG_ROWS) expect(count(both, squash(r.description)), r.description).toBe(1);
    for (const w of ["ค่าอาหารและเครื่องดื่ม", "ค่าพาหนะ"]) expect(count(both, w)).toBe(count(squash(visibleText(html)), w));
  }, 60_000);
});

// The owner's own example, read back by both engines that matter.
//
// poppler (pdftotext) trusts /ActualText and so can read right while Chrome reads wrong;
// PDFium is Chrome's — and Google Drive's — PDF engine, the text its search and copy use.
// Both must give every phrase back exactly as often as the page shows it.

const hasPdfium = commandWorks("python3", ["-c", "import pypdfium2"]);
const PDFIUM_SCRIPT = fileURLToPath(new URL("../../../scripts/pdfium-text.py", import.meta.url));
const pdfiumText = (bytes: Buffer) => execFileSync("python3", [PDFIUM_SCRIPT], { input: bytes, encoding: "utf8" });
const EXAMPLE_LINES = ["ใบงานเลขที่ FOLK-BKK-20260925-01", "วันที่ปฏิบัติงาน 25 กันยายน 2569 (รอบที่ 1)"];
const EXAMPLE_PHRASES = [
  "ใบงานเลขที่", "วันที่ปฏิบัติงาน", "25 กันยายน 2569", "รอบที่ 1", "ค่าอาหารและเครื่องดื่ม", "ค่าพาหนะ",
  "ใบรับรองแทนใบเสร็จรับเงิน", "บริษัท", "น้ำดื่ม", "ก๋วยเตี๋ยว", "ค่ารถตุ๊กตุ๊ก",
];
const exampleHtml = () => {
  // slotIdx 2: were anything to read the slot, the page would say รอบที่ 2 or 3.
  const payload = buildPayload({ ...FACTS, jobRef: "FOLK-BKK-20260925-01", tourDate: "2026-09-25", slotIdx: 2 }, certifiableRows(THAI_ROWS));
  return renderCertificateHtml({
    certificateNo: "CERT-FOLK-BKK-TEST-01",
    payload, payloadHash: payloadHash(payload),
    attestedByName: "มาลี ทดสอบ", attestedByRole: "ADMIN",
    attestedAt: "2099-04-03T09:15:00.000Z", auditRef: "cert_test",
  });
};
/** The same page drawn only in the face production used when Chrome read it wrong. */
const inNotoOnly = (html: string) => html.replace(/body \{ font-family: [^;]+;/, `body { font-family: "Noto Sans Thai";`);
// `lines` is the text read in page order: poppler's plain mode reads a two-column table
// column by column (every label, then every value), so a label and its value only sit
// together in -layout mode. PDFium reads in page order already.
const readsBack = (engine: string, text: string, html: string, lines = text) => {
  const page = visibleText(html);
  for (const line of EXAMPLE_LINES) {
    expect(readBackCount(page, line), `"${line}" is on the page`).toBeGreaterThan(0);
    expect(readBackCount(lines, line), `${engine}: "${line}"`).toBe(readBackCount(page, line));
  }
  for (const p of EXAMPLE_PHRASES) {
    expect(readBackCount(page, p), `"${p}" is on the page`).toBeGreaterThan(0);
    expect(readBackCount(text, p), `${engine}: "${p}"`).toBe(readBackCount(page, p));
  }
  expect(readBackCount(text, "รอบที่ 0"), engine).toBe(0);
  expect(readBackCount(text, "รอบที่ 2"), engine).toBe(0);
};
const needTools = (pdfium = false) => {
  const missing = [!hasUmpush() && "Umpush", !hasPdftotext && "pdftotext", pdfium && !hasPdfium && "pypdfium2"].filter(Boolean);
  if (!missing.length) return true;
  if (process.env.CI) throw new Error(`CI installs these, and here they are missing: ${missing.join(", ")}`);
  console.warn(`[renderer] ${missing.join(", ")} missing here — runs in CI`);
  return false;
};

describeRenderer("FOLK-BKK-20260925-01, read back as a person reads it", () => {
  it("pdftotext and PDFium both give back both lines and every phrase, once each", async () => {
    if (!needTools(true)) return;
    const html = exampleHtml();
    const bytes = await renderPdf(html);
    keepSample("certificate-FOLK-BKK-20260925-01.pdf", bytes);
    expectWholePdf(bytes);
    expect(unmappedGlyphCount(bytes), "glyphs that map to U+0000").toBe(0);
    readsBack("pdftotext", pdftotext(bytes), html, pdftotext(bytes, undefined, true));
    readsBack("PDFium", pdfiumText(bytes), html);
  }, 60_000);

  it("and the check can fail: the same page in Noto Sans Thai does not read back in PDFium", async () => {
    // The control. Were readsBack() unable to fail, the test above would prove nothing.
    // Noto lifts a tone mark over an upper vowel with a glyph mapped to U+0000; PDFium
    // prints /ActualText and the glyphs both — "วันวั ที่ปฏิบัติบั ติงาน".
    if (!needTools(true)) return;
    if (!hasNoto()) {
      if (process.env.CI) throw new Error("fonts-noto-core is installed in CI — the control needs Noto Sans Thai");
      return void console.warn("[renderer] Noto Sans Thai missing here — the control runs in CI");
    }
    const bytes = await renderPdf(inNotoOnly(exampleHtml()));
    expect(bytes.toString("latin1"), "the control is drawn in Noto").toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSansThai/);
    keepSample("control-noto-sans-thai.pdf", bytes);
    expect(unmappedGlyphCount(bytes), "Noto should leave glyphs unmapped").toBeGreaterThan(0);
    expect(() => readsBack("PDFium", pdfiumText(bytes), exampleHtml())).toThrow();
  }, 60_000);
});

// Every Thai cluster, not just the words on one sample page.
//
// Which clusters a face doubles depends on its mark positioning, so a handful of words
// proves little: Laksaman passed every cluster alone and still doubled วันที่ปฏิบัติงาน in a
// sentence; Loma passed this file's words and lost 560 clusters. So: every consonant with
// every upper and lower vowel, every tone mark, ์ and ำ, each between two letters, in the
// certificate's own face stack at the weights and styles the page uses.

const CONSONANTS = [..."กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ"];
const CLUSTERS = (() => {
  const up = ["ิ", "ี", "ึ", "ื", "ั", "็"], lo = ["ุ", "ู"], tone = ["่", "้", "๊", "๋"];
  const out: string[] = [];
  for (const c of CONSONANTS) {
    for (const u of up) { out.push(c + u); if (u !== "็") for (const t of tone) out.push(c + u + t); }
    for (const l of lo) { out.push(c + l); for (const t of tone) out.push(c + l + t); }
    for (const t of tone) out.push(c + t, c + t + "ำ", c + t + "า");
    out.push(c + "ำ", c + "์", c + "ิ์", c + "ุ์");
  }
  return [...new Set(out.map((x) => "ก" + x + "ว"))];
})();
const clusterPage = (style: string) => `<!doctype html><html lang="th"><head><meta charset="utf-8"><style>
body { font-family: ${FONT_STACK}; font-size: 11pt; line-height: 1.5; ${style} }</style></head>
<body>${CLUSTERS.map((w, i) => w + (i % 12 === 11 ? "<br>" : " ")).join("")}</body></html>`;

describeRenderer("every Thai cluster reads back in Chrome's engine", () => {
  for (const [name, style] of [["regular", ""], ["bold", "font-weight: 700;"], ["italic", "font-style: italic; font-size: 9.5pt;"]] as const) {
    it(`${CLUSTERS.length} clusters, ${name}: each read back by PDFium and poppler, none mapped to nothing`, async () => {
      if (!needTools(true)) return;
      const bytes = await renderPdf(clusterPage(style));
      keepSample(`clusters-${name}.pdf`, bytes);
      expect(bytes.toString("latin1"), "drawn in Umpush").toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Umpush/);
      expect(unmappedGlyphCount(bytes), "glyphs that map to U+0000").toBe(0);
      const [a, p] = [pdfiumText(bytes), pdftotext(bytes)];
      expect(CLUSTERS.filter((w) => readBackCount(a, w) !== 1), "PDFium").toEqual([]);
      expect(CLUSTERS.filter((w) => readBackCount(p, w) !== 1), "pdftotext").toEqual([]);
    }, 120_000);
  }
});
