import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_RECORDED_EXPLAINER_TH, availableSources, defaultSource, EXPENSE_SOURCES,
  isExpenseSource, sourceRefusal, sourceSentenceTh,
} from "@/lib/certificates/source";
import { buildPayload, canonicalString, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";

// Where a certificate says its figures came from.
//
// The difference between the two is not paperwork: one says a guide reported something,
// the other says an admin did. Who is answerable if the figures are wrong depends on
// which, so the document must say which, and must never hint at the one that did not
// happen.
//
// All data invented — this repo is public.

const FACTS: SheetFacts = {
  jobRef: "FOLK-TEST-20990401-01", tourDate: "2099-04-01", slotIdx: 0,
  guideId: "G-900", guideName: "Somchai Testsuite", guideReportedAt: null,
};
const ROWS = [{ index: 0, identity: "ferry|1100|4|transport|guide", description: "Ferry", pax: 4, price: 11, amountSatang: 4400, category: "transport" }];
const ADMIN_AT = "2099-04-05T03:00:00.000Z";
const RECORDED = { id: "u_admin", name: "Anong Testsuite", role: "ADMIN", at: ADMIN_AT };
const when = (iso: string) => `[${iso}]`;

describe("which source a job sheet allows", () => {
  it("a guide who filed may be said to have filed; one who did not, may not", () => {
    const filed = availableSources({ guideExpensesAt: new Date("2099-04-02T06:30:00Z") });
    expect(filed.find((s) => s.source === "GUIDE_REPORTED")!.available).toBe(true);
    const never = availableSources({ guideExpensesAt: null });
    expect(never.find((s) => s.source === "GUIDE_REPORTED")!.available).toBe(false);
    expect(never.find((s) => s.source === "GUIDE_REPORTED")!.reason).toContain("ไกด์ยังไม่ได้ส่งรายงาน");
  });

  it("an admin may always record, which is the case the option exists for", () => {
    for (const at of [null, new Date()]) {
      expect(availableSources({ guideExpensesAt: at }).find((s) => s.source === "ADMIN_RECORDED")!.available).toBe(true);
    }
  });

  it("the guide's own report is offered first when there is one", () => {
    expect(defaultSource({ guideExpensesAt: new Date() })).toBe("GUIDE_REPORTED");
    expect(defaultSource({ guideExpensesAt: null })).toBe("ADMIN_RECORDED");
  });

  it("choosing GUIDE_REPORTED without a report is refused, in Thai", () => {
    expect(sourceRefusal("GUIDE_REPORTED", { guideExpensesAt: null })).toContain("ไกด์ยังไม่ได้ส่งรายงาน");
    expect(sourceRefusal("GUIDE_REPORTED", { guideExpensesAt: new Date() })).toBeNull();
    expect(sourceRefusal("ADMIN_RECORDED", { guideExpensesAt: null })).toBeNull();
  });

  it("only these two words are a source", () => {
    expect([...EXPENSE_SOURCES]).toEqual(["GUIDE_REPORTED", "ADMIN_RECORDED"]);
    for (const junk of ["", "guide", "ADMIN", "admin_recorded", null, 7, {}]) {
      expect(isExpenseSource(junk), `${String(junk)}`).toBe(false);
    }
  });
});

describe("what the document says about where the figures came from", () => {
  it("a guide's report is dated from their own filing", () => {
    const s = sourceSentenceTh({ source: "GUIDE_REPORTED", guideReportedAt: "2099-04-02T06:30:00.000Z", recordedByName: null, recordedAt: null }, when);
    expect(s).toBe("ไกด์ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนเมื่อ [2099-04-02T06:30:00.000Z]");
  });

  it("an admin recording says so, names them, and says the guide did not file", () => {
    const s = sourceSentenceTh({ source: "ADMIN_RECORDED", guideReportedAt: null, recordedByName: "Anong Testsuite", recordedAt: ADMIN_AT }, when);
    expect(s).toContain("ผู้ดูแลระบบ Anong Testsuite บันทึกรายการจากข้อมูลที่ตรวจสอบแล้วเมื่อ");
    expect(s).toContain("ไกด์ไม่ได้ส่งรายงานผ่านบัญชีของตนสำหรับใบงานนี้");
  });

  it("an admin-recorded document never claims the guide reported anything", () => {
    const s = sourceSentenceTh({ source: "ADMIN_RECORDED", guideReportedAt: null, recordedByName: "Anong", recordedAt: ADMIN_AT }, when);
    expect(s).not.toContain("ไกด์ส่งรายงาน");
  });

  it("a draft says what WILL be recorded and invents no time", () => {
    const s = sourceSentenceTh({ source: "ADMIN_RECORDED", guideReportedAt: null, recordedByName: "Anong", recordedAt: null, draft: true }, when);
    expect(s).toContain("จะเป็นผู้บันทึกรายการจากข้อมูลที่ตรวจสอบแล้วเมื่อยืนยัน");
    expect(s).not.toContain("[");  // no timestamp was formatted at all
  });
});

describe("the source is part of what the fingerprint covers", () => {
  const guide = buildPayload({ ...FACTS, guideReportedAt: new Date("2099-04-02T06:30:00Z") }, ROWS, null, { source: "GUIDE_REPORTED", recordedBy: null });
  const admin = buildPayload(FACTS, ROWS, null, { source: "ADMIN_RECORDED", recordedBy: RECORDED });

  it("the two are different documents and hash differently", () => {
    expect(payloadHash(guide)).not.toBe(payloadHash(admin));
    expect(canonicalString(admin)).toContain("source=ADMIN_RECORDED");
    expect(canonicalString(admin)).toContain(`recordedBy=u_admin:${ADMIN_AT}`);
  });

  it("who recorded it is in the fingerprint, so swapping the person changes it", () => {
    const other = buildPayload(FACTS, ROWS, null, { source: "ADMIN_RECORDED", recordedBy: { ...RECORDED, id: "u_someone_else" } });
    expect(payloadHash(other)).not.toBe(payloadHash(admin));
  });

  it("a guide-reported payload carries no recorder", () => {
    expect(guide.recordedBy).toBeNull();
    expect(canonicalString(guide)).toContain("recordedBy=;");
  });
});

// ── the draft ────────────────────────────────────────────────────────────────

const view = (over: Record<string, unknown>) => ({
  certificateNo: "CERT-FOLK-TEST-20990401-01-01",
  payload: buildPayload(FACTS, ROWS, null, { source: "ADMIN_RECORDED", recordedBy: RECORDED }),
  payloadHash: "a".repeat(64),
  attestedByName: "Anong Testsuite", attestedByRole: "ADMIN",
  attestedAt: "2099-04-06T04:00:00.000Z", auditRef: "cert_test_1",
  ...over,
});

describe("a draft is a different document, not a faded one", () => {
  const draft = () => renderCertificateHtml(view({
    certificateNo: "(ร่าง) FOLK-TEST-20990401-01",
    attestedByName: "", attestedByRole: "", attestedAt: "", auditRef: "", draft: true,
  }) as never);

  it("carries the watermark, positioned to repeat on every page", () => {
    const html = draft();
    expect(html).toContain("ร่าง — ยังไม่รับรอง · ยังไม่ใช่หลักฐานบัญชี");
    expect(html).toContain('class="draft-mark"');
    // Fixed inside a paged medium is what makes it appear on each sheet rather than once.
    expect(html).toMatch(/\.draft-mark\s*\{[^}]*position:\s*fixed/);
  });

  it("has no attester, no audit reference and no signature", () => {
    const html = draft();
    expect(html).not.toContain("cert_test_1");
    expect(html).not.toContain('class="approve"');
    expect(html).not.toContain('class="sig"');
    expect(html).not.toContain("รับรองเอกสารทางอิเล็กทรอนิกส์");
  });

  it("says in as many words that it is not evidence yet", () => {
    expect(draft()).toContain("ยังใช้เป็นหลักฐานประกอบการบันทึกบัญชีไม่ได้");
  });

  it("the real document has all of those and no watermark", () => {
    const real = renderCertificateHtml(view({}) as never);
    expect(real).not.toContain('class="draft-mark"');
    expect(real).not.toContain("ร่าง — ยังไม่รับรอง");
    expect(real).toContain("cert_test_1");
    expect(real).toContain('class="approve"');
  });

  it("an admin-recorded draft says who WILL record, with no time", () => {
    const html = draft();
    expect(html).toContain("จะเป็นผู้บันทึกรายการจากข้อมูลที่ตรวจสอบแล้วเมื่อยืนยัน");
    expect(html).toContain("Anong Testsuite");
  });
});

describe("the draft endpoint changes nothing", () => {
  const src = () => readFileSync(join(process.cwd(), "src/app/api/jobsheet/certificate/draft/route.ts"), "utf8");

  it("creates no certificate, writes no audit, touches no Drive and calls no accounting", () => {
    const s = src().replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [
      "createCertificate", "expenseCertificate.create", "jobSheet.update",
      "audit(", "uploadCertificate", "linkCertificate", "saveBufferToDrive", "peak",
    ]) {
      expect(s, `the draft endpoint uses ${forbidden}`).not.toContain(forbidden);
    }
    // The one write it is allowed: recording that somebody without permission asked.
    expect(src()).toContain("denied(session");
  });

  it("serves inline and is never cached", () => {
    const s = src();
    expect(s).toContain('"cache-control": "private, no-store"');
    expect(s).toMatch(/content-disposition[^\n]*inline/);
    expect(s).toContain("application/pdf");
  });

  it("uses the same server renderer as the real document", () => {
    expect(src()).toContain('from "@/lib/certificates/pdf"');
    expect(src()).toContain("renderPdf(");
    expect(src()).toContain("renderCertificateHtml");
  });

  it("takes only an enum from the request — never a name, a time or a person", () => {
    const s = src();
    // The query schema is the whole contract with the browser. Four fields, and the only
    // one that says anything about a person is a word from a fixed set.
    const schema = s.slice(s.indexOf("const query = z.object("), s.indexOf("export async function GET"));
    expect(schema.match(/^\s*(\w+):/gm)!.map((m) => m.trim().replace(":", "")).sort())
      .toEqual(["date", "guideId", "slotIdx", "source"]);
    expect(s).toContain("isExpenseSource");

    // And the recorder is built from the session, with the attestation fields blank —
    // a draft has no attester, so there is nothing for a request to forge.
    expect(s).toContain("session!.user!.id");
    expect(s).toMatch(/attestedByName:\s*""/);
    expect(s).toMatch(/attestedAt:\s*""/);
    expect(s).toMatch(/auditRef:\s*""/);
  });
});

it("the explainer tells an admin what the document will say about them", () => {
  expect(ADMIN_RECORDED_EXPLAINER_TH).toContain("ผู้ดูแลระบบเป็นผู้บันทึกรายการ ไม่ใช่ไกด์");
});
