import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// What this feature does to work that does not use it.
//
// Kept apart from the integrity tests on purpose. Those ask whether a document is still
// what it was; these ask a blunter question — does adding certificates change anything
// for a job that has none? A deployment where nobody has issued one, and the receipts
// rule is still off, must price, post and pay exactly as it did before, and must not
// call Drive to do it. A Drive outage is then not even visible.
//
// Two rules that are easy to conflate and must not be:
//
//   the receipts rule   may a row with NO evidence be paid at all?
//                       REIMBURSEMENT_EVIDENCE_REQUIRED decides. Off: reported, paid.
//
//   the integrity rule  is the document a row ALREADY names still what it was?
//                       Not flag-gated. A document known to have been edited is not
//                       usable evidence whatever the deployment switch says.
//
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import type { Expense } from "@/lib/jobsheet";
import { evidenceRequired, evidenceState, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { certificateStatuses } from "@/lib/certificates/evidence";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable } from "@/lib/peak-payment-document";
import { tourCostBreakdown } from "@/lib/peak-sync";
import { checkEvidenceBeforePaying, type EvidenceStage } from "@/lib/certificates/gate";
import { attestCertificate, createCertificate, linkCertificate, uploadCertificate, type Actor, type Deps } from "@/lib/certificates/service";
import { DuplicateCertificateFile, type CertificateDrive, type PutAttemptInput } from "@/lib/certificates/drive";

const GUIDE = "G-900";
const DATE = "2099-04-01";
const REF = "FOLK-TEST-20990401-01";
const ENV = "test-env";
const ADMIN: Actor = { id: "u_admin", name: "Malee Testsuite", role: "ADMIN" };

type Row = Record<string, unknown>;
const e = (description: string, price: number, pax = 5, over: Row = {}): Row =>
  ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

// The same fake Drive as the integrity suite, plus a switch that makes every call fail.
type FakeFile = { id: string; name: string; folder: string; certificateId: string; environment: string; attemptToken: string | null; state: "TEMP" | "ACTIVE" | "RETIRED" | "QUARANTINED" | null; bytes: Buffer; revisionId: string; readOnly?: boolean };
const drive = {
  files: [] as FakeFile[], revisions: 0, calls: 0, down: false,
  reset() { this.files = []; this.revisions = 0; this.calls = 0; this.down = false; },
  active() { return this.files.filter((f) => f.state === "ACTIVE"); },
  shape(f: FakeFile) { return { id: f.id, name: f.name, link: `https://drive.example.test/file/${f.id}`, attemptToken: f.attemptToken, state: f.state, revisionId: f.revisionId, md5: null, readOnly: f.readOnly }; },
};
const fakeDrive = (): CertificateDrive => {
  const key = (p: string[]) => p.join("/");
  const touch = () => { drive.calls++; if (drive.down) throw new Error("drive 503: unavailable"); };
  const mine = (o: { certificateId: string; environment: string; folderPath: string[] }) =>
    drive.files.filter((f) => (f.state === "TEMP" || f.state === "ACTIVE") && f.certificateId === o.certificateId && f.environment === o.environment && f.folder === key(o.folderPath));
  const make = (o: PutAttemptInput, state: "TEMP" | "ACTIVE"): FakeFile => {
    const f: FakeFile = { id: `drive_${drive.files.length + 1}`, name: o.name, folder: key(o.folderPath), certificateId: o.certificateId, environment: o.environment, attemptToken: o.attemptToken, state, bytes: o.bytes, revisionId: `rev_${++drive.revisions}`, readOnly: state === "ACTIVE" };
    drive.files.push(f);
    return f;
  };
  return {
    async findAll(o) { touch(); return mine(o).map((f) => drive.shape(f)); },
    async findActive(o) { touch(); return mine(o).filter((f) => f.state === "ACTIVE").map((f) => drive.shape(f)); },
    async findAttempt(o) { touch(); return mine(o).filter((f) => f.attemptToken === o.attemptToken && f.state === "TEMP").map((f) => drive.shape(f)); },
    async findActiveByAttempt(o) { touch(); return mine(o).filter((f) => f.attemptToken === o.attemptToken && f.state === "ACTIVE").map((f) => drive.shape(f)); },
    async putAttempt(o) {
      touch();
      const own = mine(o).filter((f) => f.attemptToken === o.attemptToken && f.state === "TEMP");
      if (own.length > 1) throw new DuplicateCertificateFile(o.certificateId, "TEMP", own.map((f) => f.id));
      if (own.length === 1) { own[0].bytes = o.bytes; own[0].revisionId = `rev_${++drive.revisions}`; return drive.shape(own[0]); }
      return drive.shape(make(o, "TEMP"));
    },
    async createActive(o) { touch(); return drive.shape(make(o, "ACTIVE")); },
    async retire({ fileId }) { touch(); const f = drive.files.find((x) => x.id === fileId); if (f) { f.state = "RETIRED"; f.certificateId = ""; f.attemptToken = null; } },
    async read({ fileId }) { touch(); return drive.files.find((x) => x.id === fileId)?.bytes ?? null; },
    async quarantine({ fileId }) { touch(); const f = drive.files.find((x) => x.id === fileId); if (f) { f.state = "QUARANTINED"; f.certificateId = ""; f.attemptToken = null; } },
  };
};
const deps = (over: Deps = {}): Deps => ({
  renderPdf: async (html: string) => Buffer.from(`%PDF-1.4 ${html.length}`),
  drive: fakeDrive(), environment: ENV, ...over,
});

const ROWS: Row[] = [e("Ferry", 11), e("Temple", 500, 2, { paidBy: "advance", expenseType: "entrance" })];
const seedSheet = async (rows: Row[] = ROWS) =>
  prisma.jobSheet.create({ data: {
    ref: REF, guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
    bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, expenses: rows as object[],
    guideExpensesAt: new Date("2099-04-02T06:30:00.000Z"), approvalStatus: "APPROVED",
  } });

const rowsNow = async (): Promise<ExpenseWithEvidence[]> =>
  ((await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } }))!.expenses as unknown as ExpenseWithEvidence[]);

/** Take a sheet all the way to having a linked certificate. */
const linkOne = async () => {
  const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
  await attestCertificate(c.id, ADMIN, deps());
  await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
  return linkCertificate(c.id, ADMIN, deps());
};

/** The three gates, asked the same way each time. */
const gate = async (stage: EvidenceStage) =>
  checkEvidenceBeforePaying([await rowsNow() as Expense[]], { actorId: ADMIN.id, actorRole: ADMIN.role }, deps(), stage);
const allGates = async () => ({
  preview: await gate("preview"),
  document: await gate("document"),
  payment: await gate("payment"),
});

// The standard chart, as every other test of this builder uses it.
const ACCOUNTS = {
  guideFee: { code: "510111", name: "ค่าจ้างมัคคุเทศก์" },
  reviewReward: { code: "510110", name: "ค่ารีวิวลูกค้า" },
  categories: {
    entrance: { code: "510104", name: "ต้นทุนการให้บริการ" },
    transport: { code: "510104", name: "ต้นทุนการให้บริการ" },
    meal: { code: "510104", name: "ต้นทุนการให้บริการ" },
    other: { code: "510104", name: "ต้นทุนการให้บริการ" },
  },
};

/** What the PEAK document builder makes of the sheet as it stands. */
const buildDocument = async () => {
  const rows = await rowsNow();
  const sheet = (await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } }))!;
  return buildGuidePaymentDocument({
    guideId: GUIDE, peakContactId: "peak-contact-1", paymentRef: "FOLK-PAY-209904-01",
    jobs: [{ date: DATE, slotIdx: 0, ref: REF, tourId: "T-900", expenses: rows as Expense[], guideFee: sheet.guideFee as never, approvalStatus: "APPROVED" } as never],
    accounts: ACCOUNTS as never, certificates: await certificateStatuses([rows as Expense[]]),
  });
};

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
  drive.reset();
  authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: "ADMIN" } });
});
afterEach(() => vi.unstubAllEnvs());

const flagOn = () => vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
const flagOff = () => vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "0");

describe("1 — receipts not enforced, and no certificate anywhere", () => {
  it("nothing is refused, and the figures are the figures", async () => {
    flagOff();
    await seedSheet();
    expect(evidenceRequired()).toBe(false);

    const g = await allGates();
    for (const stage of ["preview", "document", "payment"] as const) {
      expect(g[stage].ok, stage).toBe(true);
      expect(g[stage].checked, stage).toBe(0);      // there was nothing to check
    }
    const doc = await buildDocument();
    expect(doc.evidenceGaps).toHaveLength(1);       // reported…
    expect(doc.traces.some((l) => l.kind === "REIMBURSEMENT")).toBe(true); // …and still posted
  });

  it("Drive is never called for a job that names no certificate", async () => {
    flagOff();
    await seedSheet();
    drive.down = true;                               // a total outage
    const g = await allGates();
    expect(Object.values(g).every((x) => x.ok)).toBe(true);
    expect(drive.calls, "Drive was contacted for a job with no certificate").toBe(0);
    await expect(buildDocument()).resolves.toBeTruthy();
  });
});

describe("2 — receipts enforced, and no certificate anywhere", () => {
  it("the row is refused, by the receipts rule and not by this feature", async () => {
    flagOn();
    await seedSheet();
    // The gates have nothing to say: no row names a certificate.
    const g = await allGates();
    expect(Object.values(g).every((x) => x.ok)).toBe(true);
    // The refusal comes from the document builder, exactly as it did before.
    await expect(buildDocument()).rejects.toBeInstanceOf(PaymentDocumentNotPostable);
    try { await buildDocument(); } catch (err) {
      expect((err as PaymentDocumentNotPostable).reasons.join(" ")).toContain("no receipt attached");
    }
  });
});

describe("3 and 4 — a linked certificate that is intact", () => {
  for (const [name, setFlag] of [["receipts not enforced", flagOff], ["receipts enforced", flagOn]] as const) {
    it(`passes every gate, ${name}`, async () => {
      await seedSheet();
      await linkOne();
      setFlag();
      const g = await allGates();
      for (const stage of ["preview", "document", "payment"] as const) {
        expect(g[stage].ok, `${stage} / ${name}`).toBe(true);
        expect(g[stage].checked, stage).toBe(1);
      }
      const doc = await buildDocument();
      expect(doc.evidenceGaps).toHaveLength(0);     // the row is evidenced
      expect(doc.traces.some((l) => l.kind === "REIMBURSEMENT")).toBe(true);
    });
  }
});

describe("5 and 6 — a linked certificate whose document has been edited", () => {
  for (const [name, setFlag] of [["receipts not enforced", flagOff], ["receipts enforced", flagOn]] as const) {
    it(`is refused at all three gates and marked stale, ${name}`, async () => {
      await seedSheet();
      const cert = await linkOne();
      setFlag();
      drive.active()[0].bytes = Buffer.from("EDITED IN DRIVE");
      drive.active()[0].revisionId = "rev_edited";

      // Refused whatever the flag says: the system already knows this document changed.
      for (const stage of ["preview", "document", "payment"] as const) {
        const g = await gate(stage);
        expect(g.ok, `${stage} / ${name}`).toBe(false);
      }
      expect((await prisma.expenseCertificate.findUnique({ where: { id: cert.id } }))!.status).toBe("STALE");

      // …and the row stops reading as evidenced everywhere else too.
      const rows = await rowsNow();
      expect(evidenceState(rows[0], await certificateStatuses([rows as Expense[]])).state).toBe("BLOCKED");
    });
  }
});

describe("7 — Drive down, receipts not enforced, nothing names a certificate", () => {
  it("is not affected, because Drive is not consulted", async () => {
    flagOff();
    await seedSheet();
    drive.down = true;
    const g = await allGates();
    expect(Object.values(g).every((x) => x.ok)).toBe(true);
    expect(drive.calls).toBe(0);
  });
});

describe("8 — Drive down, receipts not enforced, but a row names a linked certificate", () => {
  it("is refused rather than assumed good", async () => {
    await seedSheet();
    await linkOne();
    flagOff();
    drive.down = true;
    for (const stage of ["preview", "document", "payment"] as const) {
      const g = await gate(stage);
      expect(g.ok, stage).toBe(false);
      expect(g.reasons.join(" ")).toContain("could not be checked in Drive");
    }
  });

  it("but it is not branded stale — an outage is not an edited document", async () => {
    await seedSheet();
    const cert = await linkOne();
    flagOff();
    drive.down = true;
    await gate("payment");
    expect((await prisma.expenseCertificate.findUnique({ where: { id: cert.id } }))!.status).toBe("LINKED");
  });
});

describe("9 — Drive down with receipts enforced", () => {
  it("is refused at every gate", async () => {
    await seedSheet();
    await linkOne();
    flagOn();
    drive.down = true;
    for (const stage of ["preview", "document", "payment"] as const) {
      expect((await gate(stage)).ok, stage).toBe(false);
    }
  });
});

describe("10 — a job with no certificate is priced exactly as it was before", () => {
  it("gross, withholding, net and the posted lines are untouched", async () => {
    flagOff();
    // A sheet with the shapes that actually occur: the guide's own money, an advance,
    // a company-paid row and a review incentive.
    await seedSheet([
      e("Ferry", 11), e("Water", 10, 5, { expenseType: "meal" }),
      e("Temple", 500, 2, { paidBy: "advance", expenseType: "entrance" }),
      e("Van", 800, 1, { paidBy: "company" }),
      { description: "Review reward", price: 50, pax: 2 },
    ]);
    const rows = await rowsNow();
    const sheet = (await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } }))!;

    // The central calculator, which every screen and document reads from.
    const b = tourCostBreakdown(rows as Expense[], sheet.guideFee as never);
    expect(b.feeGross).toBe(1200);
    expect(b.reviewReward).toBe(100);
    expect(b.reimbursableToGuide).toBe(105);        // 55 + 50
    expect(b.fundedByAdvance).toBe(1000);
    expect(b.fundedByCompany).toBe(800);
    expect(b.unresolved).toBe(0);
    expect(b.grossPayable).toBe(1405);
    expect(b.withholding).toBe(39);                 // 3% of 1,300
    expect(b.netTransfer).toBe(1366);

    // And the document that would be posted says the same, with the gap reported.
    const doc = await buildDocument();
    expect(doc.gross).toBe(1405);
    expect(doc.wht).toBe(39);
    expect(doc.total).toBe(1366);
    expect(doc.evidenceGaps).toHaveLength(2);       // ferry and water, reported only
    expect(drive.calls).toBe(0);
  });
});

describe("deploying this, with the flag still unset, changes nothing by itself", () => {
  it("no certificate exists until somebody makes one", async () => {
    await seedSheet();
    expect(await prisma.expenseCertificate.count()).toBe(0);
    await buildDocument();
    await allGates();
    expect(await prisma.expenseCertificate.count()).toBe(0);
  });

  it("no row is touched, and no waiver appears", async () => {
    await seedSheet();
    const before = JSON.stringify(await rowsNow());
    await buildDocument();
    await allGates();
    expect(JSON.stringify(await rowsNow())).toBe(before);
    expect((await rowsNow()).some((r) => r.evidenceWaiver)).toBe(false);
  });

  it("and the PEAK document is still creatable", async () => {
    flagOff();
    await seedSheet();
    const doc = await buildDocument();
    expect(doc.traces.length).toBeGreaterThan(0);
    expect(doc.total).toBeGreaterThan(0);
  });
});
