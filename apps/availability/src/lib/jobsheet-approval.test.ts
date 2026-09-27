import { describe, it, expect } from "vitest";
import { approvalHtml, approvalView, fmtApprovedAt, JOB_SHEET_ROLE_NOTE_TH } from "@/lib/jobsheet-approval";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("job sheet approval — what the sheet says instead of a certification", () => {
  it("approved: status, approver and the time in Bangkok", () => {
    const v = approvalView({ approvalStatus: "APPROVED", approvedAt: "2030-05-07T07:05:00Z" }, "Approver Example");
    expect(v).toEqual({ approved: true, statusTh: "อนุมัติแล้ว", statusEn: "Approved", approverName: "Approver Example", approvedAt: "7 May 2030 14:05" });
  });

  it("not approved: names nobody and gives no time, even if stale fields linger", () => {
    const v = approvalView({ approvalStatus: null, approvedAt: "2030-05-07T07:05:00Z" }, "Approver Example");
    expect(v).toEqual({ approved: false, statusTh: "ยังไม่อนุมัติ", statusEn: "Not approved", approverName: null, approvedAt: null });
  });

  it("a bad or missing date is shown as unknown, never as a made-up one", () => {
    expect(fmtApprovedAt(null)).toBeNull();
    expect(fmtApprovedAt("not a date")).toBeNull();
    expect(approvalView({ approvalStatus: "APPROVED", approvedAt: null }, null).approvedAt).toBeNull();
  });

  it("the HTML escapes the name and says the sheet is not the certificate", () => {
    const html = approvalHtml(approvalView({ approvalStatus: "APPROVED", approvedAt: "2030-05-07T07:05:00Z" }, "<b>x</b>"), esc);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain(esc(JOB_SHEET_ROLE_NOTE_TH));
    expect(html).not.toMatch(/ข้าพเจ้าขอรับรอง|CERTIFIED BY|<img/i);
  });
});

describe("repository guard — the old certification never comes back to a job sheet", () => {
  it("no source file prints the old statement, the CERTIFIED BY heading, or the fixed signature image", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(process.cwd(), "src");
    const hits: string[] = [];
    (function walk(dir: string) {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.i?test\.tsx?$/.test(f)) {
          const t = readFileSync(p, "utf8");
          if (/ข้าพเจ้าขอรับรอง|CERTIFIED BY|Certified by|approver-signature/.test(t)) hits.push(p.slice(root.length + 1));
        }
      }
    })(root);
    expect(hits).toEqual([]);
  });
});
