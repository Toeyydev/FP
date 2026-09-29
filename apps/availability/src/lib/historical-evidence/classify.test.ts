import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CAMPAIGN_STATUSES, classifyJob, summarize, type CampaignCertificate, type CampaignReview, type CampaignSheet } from "@/lib/historical-evidence/classify";
import { CAMPAIGN_CUTOFF, inCampaign } from "@/lib/historical-evidence/campaign";
import { evidenceSnapshotHash } from "@/lib/historical-evidence/snapshot";
import { financialIdentity } from "@/lib/protected-expense-fields";

// All data invented — this repo is public.

type Row = Record<string, unknown>;
const e = (description: string, price: number | null, pax: number | null, over: Row = {}): Row =>
  ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

const sheet = (expenses: Row[], over: Partial<CampaignSheet> = {}): CampaignSheet => ({
  id: "js_1", ref: "FOLK-TEST-20990401-01", guideId: "G-900", date: "2026-08-01", slotIdx: 0,
  expenses, guideExpenses: null, guideExpensesAt: null, approvalStatus: "APPROVED", ...over,
});
const run = (s: CampaignSheet, certificates: CampaignCertificate[] = [], review: CampaignReview = null) => classifyJob({ sheet: s, certificates, review });
const linkedWaiver = (certId: string) => ({ evidenceWaiver: { by: "u_admin", at: "2026-09-20T00:00:00.000Z", reason: "ใบรับรองแทนใบเสร็จ ทดสอบ", certificateId: certId, certificateNo: "CERT-X-01" } });

describe("the campaign is the tours before the cutoff, by tour date", () => {
  it("before 2026-09-26 is in; the cutoff day and after are not; a malformed date is not", () => {
    expect(CAMPAIGN_CUTOFF).toBe("2026-09-26");
    expect(inCampaign("2026-09-25")).toBe(true);
    expect(inCampaign("2025-01-01")).toBe(true);
    expect(inCampaign("2026-09-26")).toBe(false);
    expect(inCampaign("2026-10-01")).toBe(false);
    expect(inCampaign("")).toBe(false);
    expect(inCampaign("25/09/2026")).toBe(false);
  });
});

describe("every job lands in exactly one status", () => {
  it("across every combination of payer, evidence, certificate and review this can see", () => {
    const payers = [undefined, "guide", "company", "advance"];
    const sources = [undefined, "operator", "guide", "category-default", "default-after-tour", "unconfirmed"];
    const types = ["transport", "entrance", "meal", "other"];
    const certs: CampaignCertificate[][] = [[], [{ id: "c1", certificateNo: "C1", status: "DRAFT" }], [{ id: "c1", certificateNo: "C1", status: "LINKED", coveredRows: [] }], [{ id: "c1", certificateNo: "C1", status: "STALE" }], [{ id: "c1", certificateNo: "C1", status: "VOID" }]];
    const seen = new Set<string>();
    let n = 0;
    for (const paidBy of payers) for (const paidBySource of sources) for (const expenseType of types) for (const cs of certs) for (const approvalStatus of ["APPROVED", null]) {
      const c = run(sheet([e("Ferry", 15, 2, { paidBy, paidBySource, expenseType })], { approvalStatus }), cs);
      expect(CAMPAIGN_STATUSES).toContain(c.status);
      expect(c.completed).toBe(c.status === "LINKED" || (c.status === "NOT_REQUIRED" && c.confirmed));
      seen.add(c.status);
      n++;
    }
    expect(n).toBeGreaterThan(900);
    expect([...seen].sort()).toEqual([...CAMPAIGN_STATUSES].sort());
  });

  it("the summary accounts for every job once", () => {
    const all = [
      run(sheet([])),
      run(sheet([e("Ferry", 15, 2)])),
      run(sheet([e("Water", 10, 2, { expenseType: "meal", paidBy: undefined, paidBySource: undefined })])),
    ];
    const s = summarize(all);
    expect(s.total).toBe(3);
    expect(Object.values(s.byStatus).reduce((t, b) => t + b.jobs, 0)).toBe(3);
  });
});

describe("CERTIFICATE LINKED — read from the certificate and the rows, nothing else", () => {
  const rows = [e("Ferry", 15, 2, linkedWaiver("c1"))];
  const covered = [{ identity: financialIdentity(rows[0] as never), description: "Ferry" }];

  it("a LINKED certificate for this sheet whose rows point back at it is complete", () => {
    const c = run(sheet(rows), [{ id: "c1", certificateNo: "CERT-X-01", status: "LINKED", coveredRows: covered }]);
    expect(c.status).toBe("LINKED");
    expect(c.completed).toBe(true);
  });

  it("every other certificate state is not complete", () => {
    for (const status of ["DRAFT", "READY_TO_ATTEST", "ATTESTED", "UPLOADED", "STALE"]) {
      const c = run(sheet([e("Ferry", 15, 2)]), [{ id: "c1", certificateNo: "CERT-X-01", status, coveredRows: covered }]);
      expect(c.completed, status).toBe(false);
      expect(c.status, status).toBe(status === "STALE" ? "NEEDS_REVIEW" : "IN_PROGRESS");
    }
  });

  it("a VOID certificate is as if there were none — the rows need a new one", () => {
    const c = run(sheet([e("Ferry", 15, 2, linkedWaiver("c1"))]), [{ id: "c1", certificateNo: "CERT-X-01", status: "VOID" }]);
    expect(c.completed).toBe(false);
    expect(c.status).toBe("READY_TO_ISSUE");
  });

  it("LINKED but a row points elsewhere, or a guide-paid row is not covered → NEEDS REVIEW", () => {
    const stray = run(sheet([e("Ferry", 15, 2, linkedWaiver("c9"))]), [{ id: "c1", certificateNo: "CERT-X-01", status: "LINKED", coveredRows: covered }]);
    expect(stray.status).toBe("NEEDS_REVIEW");
    const uncovered = run(sheet([...rows, e("Bus", 20, 2)]), [{ id: "c1", certificateNo: "CERT-X-01", status: "LINKED", coveredRows: covered }]);
    expect(uncovered.status).toBe("NEEDS_REVIEW");
  });

  it("two live certificates on one sheet fail closed", () => {
    const c = run(sheet(rows), [
      { id: "c1", certificateNo: "CERT-X-01", status: "LINKED", coveredRows: covered },
      { id: "c2", certificateNo: "CERT-X-02", status: "DRAFT" },
    ]);
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.completed).toBe(false);
  });
});

describe("NOT REQUIRED — a candidate from the data, complete only when an admin confirmed this sheet", () => {
  it("no expenses at all", () => {
    const c = run(sheet([]));
    expect(c.status).toBe("NOT_REQUIRED");
    expect(c.completed).toBe(false);
    expect(c.suggestedNotRequiredReason).toBe("NO_EXPENSES");
  });

  it("company direct, advance, and receipts are all candidates", () => {
    // Company paying for a ticket departs from the category's rule, so — exactly as on the
    // Job Sheet — it carries a reason.
    expect(run(sheet([e("Ticket", 200, 3, { expenseType: "entrance", paidBy: "company", paidByReason: "paid by company card" })])).suggestedNotRequiredReason).toBe("COMPANY_DIRECT");
    expect(run(sheet([e("Lunch", 120, 3, { expenseType: "meal", paidBy: "company" })])).suggestedNotRequiredReason).toBe("COMPANY_DIRECT");
    expect(run(sheet([e("Ticket", 200, 3, { expenseType: "entrance", paidBy: "advance" })])).suggestedNotRequiredReason).toBe("COMPANY_ADVANCE");
    // Without the reason it is not concluded.
    expect(run(sheet([e("Ticket", 200, 3, { expenseType: "entrance", paidBy: "company" })])).status).toBe("NEEDS_REVIEW");
    const receipt = run(sheet([e("Ferry", 15, 2, { receiptUrl: "https://drive.example.test/r" })]));
    expect(receipt.status).toBe("NOT_REQUIRED");
    expect(receipt.suggestedNotRequiredReason).toBe("HAS_RECEIPT");
  });

  it("unused template lines are not expenses — price with no count is 0, whatever payer was pre-filled", () => {
    const c = run(sheet([e("Grand Palace", 500, null, { expenseType: "entrance", paidBy: "guide", paidBySource: undefined })]));
    expect(c.status).toBe("NOT_REQUIRED");
  });

  it("confirmed against THIS sheet is complete", () => {
    const s = sheet([]);
    const c = run(s, [], { decision: "NOT_REQUIRED", snapshotHash: evidenceSnapshotHash(s), reasonCode: "NO_EXPENSES" });
    expect(c.confirmed).toBe(true);
    expect(c.completed).toBe(true);
  });

  it("a sheet that changed after NOT REQUIRED is reopened to NEEDS REVIEW — the old decision is not reused", () => {
    const before = sheet([e("Ticket", 200, 3, { expenseType: "entrance", paidBy: "company" })]);
    const review = { decision: "NOT_REQUIRED", snapshotHash: evidenceSnapshotHash(before), reasonCode: "COMPANY_DIRECT" };
    const after = sheet([e("Ticket", 200, 4, { expenseType: "entrance", paidBy: "company" })]);
    const c = run(after, [], review);
    expect(c.reopened).toBe(true);
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.completed).toBe(false);
  });
});

describe("Paid By — the central rules, suggested and never saved, never guessed for meals", () => {
  it("transport with no payer: suggests Guide Personal, as a suggestion — the input is not changed", () => {
    const rows = [e("Bus", 15, 3, { paidBy: undefined, paidBySource: undefined })];
    const frozen = JSON.stringify(rows);
    const c = run(sheet(rows));
    expect(c.status).toBe("NEEDS_REVIEW");
    const r = c.rows[0];
    expect(r.needsPayerConfirmation).toBe(true);
    expect(r.suggestion).toBe("GUIDE_PERSONAL");
    expect(r.storedPayer).toBe("UNSPECIFIED");
    expect(JSON.stringify(rows)).toBe(frozen); // nothing written
  });

  it("entrance suggests Guide Advance", () => {
    expect(run(sheet([e("Temple", 100, 3, { expenseType: "entrance", paidBy: undefined, paidBySource: undefined })])).rows[0].suggestion).toBe("GUIDE_ADVANCE");
  });

  it("meal and other are never guessed", () => {
    for (const expenseType of ["meal", "other"]) {
      const c = run(sheet([e("Water", 10, 3, { expenseType, paidBy: undefined, paidBySource: undefined })]));
      expect(c.status, expenseType).toBe("NEEDS_REVIEW");
      expect(c.rows[0].suggestion, expenseType).toBeNull();
    }
  });

  it("a guide-paid meal with no recorded source is not taken on trust", () => {
    const c = run(sheet([e("Water", 10, 3, { expenseType: "meal", paidBy: "guide", paidBySource: undefined })]));
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.rows[0].needsPayerConfirmation).toBe(true);
  });

  it("default-after-tour and unconfirmed never make a row ready", () => {
    for (const paidBySource of ["default-after-tour", "unconfirmed"]) {
      const c = run(sheet([e("Ferry", 15, 2, { paidBySource })]));
      expect(c.status, paidBySource).toBe("NEEDS_REVIEW");
    }
  });

  it("a transport payer only the rules filled in is a proposal, not a confirmation", () => {
    const c = run(sheet([e("Ferry", 15, 2, { paidBySource: undefined })]));
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.rows[0].basis).toBe("BUSINESS_RULE");
  });

  it("a payer against the category rule with no reason needs review", () => {
    const c = run(sheet([e("Ticket", 200, 2, { expenseType: "entrance", paidBy: "guide", paidBySource: "operator" })]));
    expect(c.status).toBe("NEEDS_REVIEW");
    const withReason = run(sheet([e("Ticket", 200, 2, { expenseType: "entrance", paidBy: "guide", paidBySource: "operator", paidByReason: "counter took card only" })]));
    expect(withReason.status).toBe("READY_TO_ISSUE");
  });
});

describe("NEEDS REVIEW — what cannot be concluded", () => {
  it("missing payer", () => expect(run(sheet([e("Ferry", 15, 2, { paidBy: undefined, paidBySource: undefined, expenseType: "other" })])).status).toBe("NEEDS_REVIEW"));

  it("a count with no price cannot be computed", () => {
    const c = run(sheet([e("Ferry", null, 4)]));
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.rows[0].issues.join()).toContain("คำนวณยอดไม่ได้");
  });

  it("two rows that read the same fail closed", () => {
    const c = run(sheet([e("Ferry", 15, 2), e("Ferry", 15, 2)]));
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.reasons.join()).toContain("ซ้ำกัน");
  });

  it("an unapproved sheet is not ready to issue", () => {
    expect(run(sheet([e("Ferry", 15, 2)], { approvalStatus: null })).status).toBe("NEEDS_REVIEW");
    expect(run(sheet([e("Ferry", 15, 2)])).status).toBe("READY_TO_ISSUE");
  });

  it("a waiver naming a certificate that changed in Drive is not evidence", () => {
    const c = run(sheet([e("Ferry", 15, 2, linkedWaiver("c1"))]), [{ id: "c1", certificateNo: "CERT-X-01", status: "STALE" }]);
    expect(c.status).toBe("NEEDS_REVIEW");
  });
});

describe("READY TO ISSUE — and which source it may claim", () => {
  it("offers the guide's report only when every row it would cover is in that report", () => {
    const rows = [e("Ferry", 15, 2)];
    const matches = run(sheet(rows, { guideExpensesAt: "2026-08-01T12:00:00.000Z", guideExpenses: [{ description: "ferry", price: 15, pax: 2 }] }));
    expect(matches.status).toBe("READY_TO_ISSUE");
    expect(matches.source.suggested).toBe("GUIDE_REPORTED");
    const differs = run(sheet(rows, { guideExpensesAt: "2026-08-01T12:00:00.000Z", guideExpenses: [{ description: "Ferry", price: 15, pax: 3 }] }));
    expect(differs.source.guideReportedAvailable).toBe(false);
    expect(differs.source.suggested).toBe("ADMIN_RECORDED");
    const none = run(sheet(rows));
    expect(none.source.suggested).toBe("ADMIN_RECORDED");
    expect(none.certifiable).toEqual({ count: 1, totalSatang: 3000 });
  });
});

describe("the fingerprint moves with the evidence and nothing else", () => {
  it("rows, the guide's report and approval move it; other fields do not exist to it", () => {
    const base = sheet([e("Ferry", 15, 2)]);
    const h = evidenceSnapshotHash(base);
    expect(evidenceSnapshotHash({ ...base })).toBe(h);
    expect(evidenceSnapshotHash({ ...base, expenses: [e("Ferry", 15, 3)] })).not.toBe(h);
    expect(evidenceSnapshotHash({ ...base, approvalStatus: null })).not.toBe(h);
    expect(evidenceSnapshotHash({ ...base, guideExpensesAt: "2026-08-02T00:00:00.000Z" })).not.toBe(h);
    // Key order in the stored JSON is not a change.
    const reordered = { ...base, expenses: [{ pax: 2, price: 15, description: "Ferry", paidBySource: "operator", paidBy: "guide", expenseType: "transport" }] };
    expect(evidenceSnapshotHash(reordered)).toBe(h);
  });
});

describe("the migration and the seed create nothing", () => {
  const root = join(__dirname, "../../..");
  it("the campaign's migration is additive: no UPDATE, DELETE, DROP or INSERT", () => {
    const dir = readdirSync(join(root, "prisma/migrations")).find((d) => d.endsWith("_historical_evidence_review"));
    expect(dir).toBeTruthy();
    const sql = readFileSync(join(root, "prisma/migrations", dir!, "migration.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\b(INSERT|DROP|TRUNCATE)\b/i);
    // ON DELETE / ON UPDATE are foreign-key clauses, not statements.
    const statements = sql.replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|SET NULL|NO ACTION)/gi, "");
    expect(statements).not.toMatch(/\b(UPDATE|DELETE)\b/i);
    expect(sql).toMatch(/CREATE TABLE "HistoricalEvidenceReview"/);
  });
  it("nothing seeds a review or a certificate", () => {
    const seed = readFileSync(join(root, "prisma/seed.ts"), "utf8");
    expect(seed).not.toMatch(/historicalEvidenceReview|expenseCertificate/i);
  });
});
