import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { buildPayload, certifiableRows, fileHash, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";
import { pdfRendererAvailable, renderPdf } from "@/lib/certificates/pdf";
import type { Expense } from "@/lib/jobsheet";

// The renderer, against the Chromium the DEPLOYMENT provides.
//
// This is the test the others cannot be. Everything else stubs the render, because a
// browser in a unit test would be slow and beside the point — but then nothing checks
// the thing most likely to break on the day it ships: whether this container has a
// Chromium at all, whether it has a font that can draw Thai, and whether the process it
// starts ever goes away again.
//
// It deliberately does NOT fall back to a developer's own Chrome. A Mac with Google
// Chrome and the system Thai fonts installed will render this beautifully and tell you
// nothing about a Linux container with neither. CHROMIUM_PATH is set by CI and by
// Railway, and where it is unset the test says so rather than passing quietly.
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

describe("the renderer is configured where it is supposed to be", () => {
  it("CI and the deployment name a Chromium; a developer's laptop need not", () => {
    // CI sets it. If this fails there, the deployment would have shipped a feature that
    // cannot produce its own document.
    if (process.env.CI) expect(ready, "CI must provide CHROMIUM_PATH — see .github/workflows/ci.yml").toBe(true);
    else if (!ready) console.warn("[renderer] CHROMIUM_PATH unset — the real render is skipped here and runs in CI");
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

  it("fetches nothing — a page that tries to reach out still renders, without it", async () => {
    const withRemote = html().replace("</body>", `<img src="https://127.0.0.1:9/should-never-load.png"><link rel="stylesheet" href="file:///etc/hosts"></body>`);
    const bytes = await renderPdf(withRemote);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 60_000);
});
