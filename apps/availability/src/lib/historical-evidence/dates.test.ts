import { describe, it, expect } from "vitest";
import { sourceSentenceTh } from "@/lib/certificates/source";
import { renderCertificateHtml, thaiDateTime } from "@/lib/certificates/document";
import { buildPayload, payloadHash } from "@/lib/certificates/payload";

// Three dates on a historical certificate, and none of them may pass for another.
//
//   วันที่ปฏิบัติงาน   the tour, as it was
//   บันทึกรายการ      when an admin actually recorded the rows — weeks later, and SAID so
//   รับรอง            when it was actually certified — never back-dated
//
// All data invented — this repo is public.

const RECORDED = "2026-09-27T03:00:00.000Z"; // 27 Sep, Bangkok
const admin = { source: "ADMIN_RECORDED" as const, guideReportedAt: null, recordedByName: "Malee Testsuite", recordedAt: RECORDED };

describe("rows recorded after the tour say so", () => {
  it("an admin recording a tour from August says it recorded them retrospectively, after the day", () => {
    const s = sourceSentenceTh({ ...admin, tourDate: "2026-08-01" }, thaiDateTime);
    expect(s).toContain("บันทึกรายการย้อนหลังจากข้อมูลที่ตรวจสอบแล้วเมื่อ");
    expect(s).toContain("ซึ่งเป็นวันหลังวันปฏิบัติงาน");
    expect(s).toContain("ไกด์ไม่ได้ส่งรายงาน");
  });
  it("recorded on the day itself is not called retrospective", () => {
    const s = sourceSentenceTh({ ...admin, tourDate: "2026-09-27" }, thaiDateTime);
    expect(s).not.toContain("ย้อนหลัง");
  });
  it("a draft for an old tour says what WILL be recorded, retrospectively, and invents no time", () => {
    const s = sourceSentenceTh({ ...admin, recordedAt: null, draft: true, tourDate: "2026-08-01", today: "2026-09-27" }, thaiDateTime);
    expect(s).toContain("จะเป็นผู้บันทึกรายการย้อนหลังจากข้อมูลที่ตรวจสอบแล้วเมื่อยืนยัน");
    expect(s).not.toMatch(/\d{1,2}:\d{2}/);
  });
  it("a guide's own report is never described as an admin's, retrospective or not", () => {
    const s = sourceSentenceTh({ source: "GUIDE_REPORTED", guideReportedAt: "2026-08-01T12:00:00.000Z", recordedByName: null, recordedAt: null, tourDate: "2026-08-01" }, thaiDateTime);
    expect(s).toContain("ไกด์ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนเมื่อ");
    expect(s).not.toContain("ย้อนหลัง");
  });
});

describe("the document never looks as if it was made on the tour date", () => {
  const facts = { jobRef: "FOLK-TEST-20260801-01", tourDate: "2026-08-01", slotIdx: 0, guideId: "G-900", guideName: "Nok Example", guideReportedAt: null };
  const payload = buildPayload(facts, [{ index: 0, identity: "Ferry|1500|200|transport|guide", description: "Ferry", pax: 2, price: 15, amountSatang: 3000, category: "transport" }], null,
    { source: "ADMIN_RECORDED", recordedBy: { id: "u_admin", name: "Malee Testsuite", role: "ADMIN", at: RECORDED } });
  const head = (h: string) => /<div class="no">([\s\S]*?)<\/div>/.exec(h)?.[1] ?? "";

  it("the heading shows the certification date, labelled — not the tour date", () => {
    const h = renderCertificateHtml({ certificateNo: "CERT-X-01", payload, payloadHash: payloadHash(payload), attestedByName: "Malee Testsuite", attestedByRole: "ADMIN", attestedAt: "2026-09-27T05:00:00.000Z", auditRef: "a1" });
    expect(head(h)).toContain("วันที่รับรอง 27 กันยายน 2569");
    expect(head(h)).not.toContain("1 สิงหาคม 2569");
    // The tour date is still there, labelled as what it is.
    expect(h).toMatch(/<th>วันที่ปฏิบัติงาน<\/th><td>1 สิงหาคม 2569/);
    expect(h).toContain("บันทึกรายการย้อนหลังจากข้อมูลที่ตรวจสอบแล้ว");
  });

  it("no real certification time — empty, unparseable or the epoch placeholder — never prints a date", () => {
    for (const attestedAt of ["", "not-a-date", new Date(0).toISOString()]) {
      const h = renderCertificateHtml({ certificateNo: "CERT-X-01", payload, payloadHash: payloadHash(payload), attestedByName: "A", attestedByRole: "ADMIN", attestedAt, auditRef: "a1" });
      expect(head(h), attestedAt).toContain("ยังไม่รับรอง");
      expect(head(h), attestedAt).not.toContain("2513");
    }
  });

  it("a draft carries no certification date at all", () => {
    const h = renderCertificateHtml({ certificateNo: "CERT-X-01", payload, payloadHash: payloadHash(payload), attestedByName: "", attestedByRole: "", attestedAt: "", auditRef: "", draft: true });
    expect(head(h)).toContain("ยังไม่รับรอง");
    expect(head(h)).not.toMatch(/\d{4}/);
  });
});
