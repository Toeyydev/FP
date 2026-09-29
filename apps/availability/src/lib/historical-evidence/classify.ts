import { expenseAmount, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { canonicalPaidBy, type PaidBy } from "@/lib/peak-sync";
import { defaultPayer, effectivePayer, expenseKind, isOverride, MIN_PAYER_REASON, payerAllowed, type DefaultablePayer, type ExpenseKind, type PayerBasis, type PayerRow } from "@/lib/payer-rules";
import { evidenceState, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { financialIdentity, type ProtectedRow } from "@/lib/protected-expense-fields";
import type { ExpenseSource } from "@/lib/certificates/source";
import { evidenceSnapshotHash, type SnapshotSheet } from "@/lib/historical-evidence/snapshot";
import { liveRequest, optInFor, type OptIn, type RequestableRow } from "@/lib/certificates/request";

// Where one historical job stands on evidence, read from the data and nothing else.
//
// Pure: a job sheet, its certificates and its review decision go in, a classification
// comes out. No database, no Drive, no PEAK — so the page can be loaded as often as
// anyone likes without changing a thing, and the same function answers the dry run
// against a copy of production.
//
// Every rule it applies is one that already exists somewhere else, called rather than
// restated: who paid (lib/payer-rules), whether a row needs evidence
// (lib/reimbursement-evidence), what a row IS (lib/protected-expense-fields). A second
// copy of any of them could drift from the first and quietly disagree about money.
//
// Each job lands in exactly one of:
//
//   LINKED          a certificate for THIS sheet is LINKED and every row it covers points
//                   back at it. Done.
//   NOT_REQUIRED    nothing on the sheet needs a certificate. Done only once an admin has
//                   confirmed it against the sheet as it is now (`confirmed`); until then
//                   it is a candidate the data suggests, never a verdict the system gave.
//                   It is never a dead end: `certificatePath` says what would have to be
//                   true for a certificate, and guide-paid rows under an older waiver or a
//                   receipt can be opted in (lib/certificates/request), which moves the job
//                   on to READY_TO_ISSUE once every figure and payer is confirmed.
//   READY_TO_ISSUE  guide-paid rows with no receipt, every figure and payer confirmed,
//                   approved, and no certificate yet. Not evidence of anything — work.
//   IN_PROGRESS     a certificate exists and is on its way (drafted, attested, filed) but
//                   is not LINKED. Not done.
//   NEEDS_REVIEW    anything that cannot be concluded from the data: a missing or
//                   unconfirmed payer, a figure that does not compute, two rows that read
//                   the same, a certificate that disagrees with the rows, a sheet that
//                   changed after a decision. Fail closed, always, to here.

export const CAMPAIGN_STATUSES = ["LINKED", "NOT_REQUIRED", "READY_TO_ISSUE", "IN_PROGRESS", "NEEDS_REVIEW"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const STATUS_LABEL_TH: Record<CampaignStatus, string> = {
  LINKED: "CERTIFICATE LINKED",
  NOT_REQUIRED: "NOT REQUIRED",
  READY_TO_ISSUE: "READY TO ISSUE",
  IN_PROGRESS: "กำลังออกใบรับรอง",
  NEEDS_REVIEW: "NEEDS REVIEW",
};

/** Why a job needs no certificate. An admin picks one; the data only suggests. */
export const NOT_REQUIRED_REASONS = [
  "NO_EXPENSES",
  "COMPANY_DIRECT",
  "COMPANY_ADVANCE",
  "HAS_RECEIPT",
  "NO_UNEVIDENCED_REIMBURSEMENT",
  "OTHER",
] as const;
export type NotRequiredReason = (typeof NOT_REQUIRED_REASONS)[number];
export const NOT_REQUIRED_REASON_TH: Record<NotRequiredReason, string> = {
  NO_EXPENSES: "ไม่มีค่าใช้จ่าย",
  COMPANY_DIRECT: "บริษัทจ่ายเองทุกรายการ",
  COMPANY_ADVANCE: "ใช้เงินทดรองบริษัททุกรายการ",
  HAS_RECEIPT: "ทุกรายการที่ไกด์จ่ายมีใบเสร็จ",
  NO_UNEVIDENCED_REIMBURSEMENT: "ไม่มีเงินที่ไกด์สำรองจ่ายที่ขาดหลักฐาน",
  OTHER: "เหตุผลอื่น (ระบุในหมายเหตุ)",
};
export const isNotRequiredReason = (v: unknown): v is NotRequiredReason =>
  typeof v === "string" && (NOT_REQUIRED_REASONS as readonly string[]).includes(v);

export const REVIEW_DECISIONS = ["NOT_REQUIRED", "REVIEWED", "REOPENED"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type CampaignCertificate = {
  id: string;
  certificateNo: string;
  status: string;
  coveredRows?: unknown;
};

export type CampaignReview = {
  decision: ReviewDecision | string;
  snapshotHash: string;
  reasonCode?: string | null;
  note?: string | null;
  decidedByName?: string | null;
  decidedAt?: Date | string | null;
  version?: number;
} | null;

export type CampaignSheet = SnapshotSheet & { status?: string | null; peakDocumentNo?: string | null };

/** What a row is, for the evidence question. */
export type RowEvidence =
  | "UNUSED"            // no amount and nothing to compute — a template line never used
  | "PAYER_UNKNOWN"     // nobody has said whose money it was
  | "NOT_GUIDE_MONEY"   // company direct or advance
  | "HAS_RECEIPT"
  | "WAIVED"            // an admin's waiver with no certificate behind it (older practice)
  | "CERTIFIED"         // a waiver naming a LINKED certificate
  | "NEEDS_CERTIFICATE" // the guide's own money, nothing behind it — or an admin asked for one on it
  | "BROKEN";           // names a certificate that is not evidence (changed in Drive, or not found)

export type RowAnalysis = {
  index: number;
  identity: string;
  description: string;
  expenseType: string;
  kind: ExpenseKind;
  price: number | null;
  pax: number | null;
  amountSatang: number;
  storedPayer: PaidBy;
  payer: PaidBy;
  basis: PayerBasis;
  /** What the rules would propose. A proposal, never written until an admin confirms it. */
  suggestion: DefaultablePayer | null;
  needsPayerConfirmation: boolean;
  evidence: RowEvidence;
  certificateId: string | null;
  /** Whether the guide's own report has a line saying the same thing. Null: no report. */
  inGuideReport: boolean | null;
  /** A receipt is attached to this row. */
  hasReceipt: boolean;
  /** This row can be opted in to a certificate, and on what footing. Null: it cannot. */
  optIn: OptIn | null;
  /** An admin asked a certificate to cover this row, and the request still describes it. */
  requested: { byName: string; at: string; receiptAcknowledged: boolean } | null;
  issues: string[];
};

export type Classification = {
  jobSheetId: string;
  status: CampaignStatus;
  completed: boolean;
  /** NOT_REQUIRED only: an admin has confirmed it against this exact sheet. */
  confirmed: boolean;
  /** A NOT_REQUIRED decision exists and the sheet has changed since. */
  reopened: boolean;
  reasons: string[];
  rows: RowAnalysis[];
  certifiable: { count: number; totalSatang: number };
  activeCertificate: { id: string; certificateNo: string; status: string } | null;
  snapshotHash: string;
  review: { decision: string; current: boolean; reasonCode: string | null; note: string | null; decidedByName: string | null; decidedAt: string | null; version: number } | null;
  suggestedNotRequiredReason: NotRequiredReason | null;
  /**
   * NOT_REQUIRED only: what would have to be true for this job to carry a certificate.
   * Steps for a person, never applied by anything.
   */
  certificatePath: string[];
  /** Rows an admin could opt in to a certificate now. */
  optInCount: number;
  source: {
    guideReportedAt: string | null;
    /** Every row the certificate would cover appears in the guide's own report. */
    guideReportMatches: boolean;
    guideReportedAvailable: boolean;
    guideReportedReason: string | null;
    suggested: ExpenseSource;
  };
};

const PERSON_CHOSE: PayerBasis[] = ["OPERATOR", "GUIDE"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const satang = (n: number) => Math.round(n * 100);
const text = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const bahtText = (satangAmount: number) => (satangAmount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A row whose amount cannot be worked out, as opposed to one that was simply not used.
 *
 * The standard lines sit on every sheet with a price and no count until somebody fills
 * them in — and older sheets had "guide" filled in as the payer on every one of them — so
 * "price, no count" is an unused line whatever its payer says: nothing was bought, the
 * amount is 0 everywhere else in FolkOPS, and nobody is owed anything for it. It is a
 * missing figure when somebody plainly spent something: a count with no price (the ferry
 * fare is left blank on purpose and has to be filled in), or a negative anywhere.
 */
function incomplete(e: Expense): boolean {
  const price = num(e.price), pax = num(e.pax);
  if ((price != null && price < 0) || (pax != null && pax < 0)) return true;
  if (price == null && pax != null && pax > 0) return true;
  return false;
}

function reportHas(report: Expense[] | null, e: Expense): boolean | null {
  if (!report) return null;
  return report.some((g) => text(g.description) === text(e.description) && num(g.price) === num(e.price) && num(g.pax) === num(e.pax));
}

export function classifyJob(input: {
  sheet: CampaignSheet;
  certificates: readonly CampaignCertificate[];
  review: CampaignReview;
}): Classification {
  const { sheet, certificates, review } = input;
  const expenses = (Array.isArray(sheet.expenses) ? sheet.expenses : []) as ExpenseWithEvidence[];
  const report = sheet.guideExpensesAt && Array.isArray(sheet.guideExpenses) ? (sheet.guideExpenses as Expense[]) : null;
  const snapshotHash = evidenceSnapshotHash(sheet);
  const statusOf: Record<string, string> = Object.fromEntries(certificates.map((c) => [c.id, c.status]));

  // ── rows ─────────────────────────────────────────────────────────────────
  const rows: RowAnalysis[] = [];
  expenses.forEach((e, index) => {
    if (isReviewExpense(e)) return; // a review reward is pay, not a reimbursement — not this question
    const kind = expenseKind(e);
    const storedPayer = canonicalPaidBy(e);
    const { payer, basis } = effectivePayer(e as PayerRow);
    const amount = expenseAmount(e);
    const broken = incomplete(e);
    const issues: string[] = [];
    let evidence: RowEvidence;
    let certificateId: string | null = null;
    let hasReceipt = false;
    const waiverCert = (e.evidenceWaiver?.certificateId ?? "").trim() || null;
    const request = liveRequest(e as RequestableRow);
    const optIn = optInFor(e as RequestableRow);

    if (!broken && amount <= 0) {
      evidence = "UNUSED";
    } else if (storedPayer === "UNSPECIFIED") {
      evidence = "PAYER_UNKNOWN";
    } else if (storedPayer !== "GUIDE_PERSONAL") {
      evidence = "NOT_GUIDE_MONEY";
    } else {
      const s = evidenceState(e, statusOf);
      // Asked for, on terms that still hold: the same test certifiableRows applies, so the
      // campaign and the certificate service agree on which rows a certificate covers.
      const asked = Boolean(request) && (optIn === "WAIVED" || (optIn === "HAS_RECEIPT" && request!.receiptAcknowledged === true));
      if (s.state === "HAS_RECEIPT") {
        hasReceipt = true;
        if (waiverCert && statusOf[waiverCert] === "LINKED") { evidence = "CERTIFIED"; certificateId = waiverCert; }
        else if (asked) evidence = "NEEDS_CERTIFICATE";
        else evidence = "HAS_RECEIPT";
        if (waiverCert && !certificateId && statusOf[waiverCert] && statusOf[waiverCert] !== "VOID") certificateId = waiverCert;
      }
      else if (s.state === "WAIVED" && !waiverCert && asked) evidence = "NEEDS_CERTIFICATE";
      else if (s.state === "WAIVED") { evidence = waiverCert ? "CERTIFIED" : "WAIVED"; certificateId = waiverCert; }
      else if (s.state === "NOT_REQUIRED") evidence = "NOT_GUIDE_MONEY";
      else if (waiverCert && statusOf[waiverCert] !== "VOID") { evidence = "BROKEN"; certificateId = waiverCert; }
      else evidence = "NEEDS_CERTIFICATE"; // no waiver, or its certificate was withdrawn
    }

    let needsPayerConfirmation = false;
    let suggestion: DefaultablePayer | null = null;
    if (evidence !== "UNUSED") {
      if (broken) issues.push("ราคาหรือจำนวนไม่ครบ คำนวณยอดไม่ได้");
      if (storedPayer === "UNSPECIFIED") {
        // Nothing stored. The rules may know what the kind implies — that is what they
        // will SUGGEST — but nobody has said it about this row.
        needsPayerConfirmation = true;
        issues.push("ยังไม่มี Paid By");
      } else if (payer === "UNSPECIFIED") {
        needsPayerConfirmation = true;
        issues.push("Paid By มาจากข้อมูลเก่าที่ไม่มีคนยืนยัน");
      } else if (basis === "UNCONFIRMED") {
        needsPayerConfirmation = true;
        issues.push("Paid By ไม่ตรงกับค่าปกติของประเภทนี้ และไม่มีคนยืนยัน");
      } else if (storedPayer === "GUIDE_PERSONAL" && !PERSON_CHOSE.includes(basis)) {
        // A payer the rules filled in is fine for a payment to rest on. It is not enough
        // for a document that says the guide spent their own money on this row.
        needsPayerConfirmation = true;
        issues.push("Paid By เป็นค่าตามกฎของประเภทนี้ ยังไม่มีคนยืนยัน");
      }
      if (!payerAllowed(kind, storedPayer)) {
        issues.push("Paid By ขัดกับกฎของประเภทค่าใช้จ่าย (ค่าอาหารใช้เงินทดรองไม่ได้)");
        needsPayerConfirmation = true;
      } else if (!needsPayerConfirmation && isOverride(kind, storedPayer)
        && ((e as { paidByReason?: string | null }).paidByReason ?? "").trim().length < MIN_PAYER_REASON) {
        issues.push("Paid By ต่างจากค่าปกติของประเภทนี้ และไม่มีเหตุผลกำกับ");
        needsPayerConfirmation = true;
      }
      if (needsPayerConfirmation) suggestion = defaultPayer(kind); // null for meals and other: a person chooses
      if (evidence === "BROKEN") {
        const st = certificateId ? statusOf[certificateId] : undefined;
        issues.push(st === "STALE"
          ? "ใบรับรองที่รายการนี้อ้างถึง เอกสารใน Drive เปลี่ยนไปแล้ว ใช้เป็นหลักฐานไม่ได้"
          : st ? `ใบรับรองที่รายการนี้อ้างถึงยังไม่ใช้เป็นหลักฐาน (${st})`
          : "ใบรับรองที่รายการนี้อ้างถึงตรวจสอบไม่ได้");
      }
    }

    rows.push({
      index,
      identity: financialIdentity(e as ProtectedRow),
      description: (e.description ?? "").trim(),
      expenseType: String(e.expenseType ?? ""),
      kind,
      price: num(e.price),
      pax: num(e.pax),
      amountSatang: satang(amount),
      storedPayer, payer, basis,
      suggestion, needsPayerConfirmation,
      evidence, certificateId,
      inGuideReport: evidence === "UNUSED" ? null : reportHas(report, e),
      hasReceipt,
      optIn: evidence === "NEEDS_CERTIFICATE" && !request ? null : optIn,
      requested: request ? { byName: request.byName, at: request.at, receiptAcknowledged: request.receiptAcknowledged === true } : null,
      issues,
    });
  });

  const live = rows.filter((r) => r.evidence !== "UNUSED");
  const reasons: string[] = [];

  // Two rows that read the same cannot be told apart, so nothing can say which one a
  // payer, a waiver or a certificate belongs to.
  const seen = new Map<string, number>();
  for (const r of live) seen.set(r.identity, (seen.get(r.identity) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  for (const [id] of dupes) {
    const r = live.find((x) => x.identity === id)!;
    reasons.push(`"${r.description || "รายการ"}" (${r.pax ?? "?"}×${r.price ?? "?"}) ซ้ำกัน ${seen.get(id)} แถว แยกไม่ได้ว่าแถวไหนคือแถวไหน`);
  }

  const needCert = live.filter((r) => r.evidence === "NEEDS_CERTIFICATE");
  const certifiable = { count: needCert.length, totalSatang: needCert.reduce((t, r) => t + r.amountSatang, 0) };
  const active = certificates.filter((c) => c.status !== "VOID");
  const current = review ? review.snapshotHash === snapshotHash : false;
  const reopened = Boolean(review && review.decision === "NOT_REQUIRED" && !current);

  // Source of the rows a certificate would cover.
  const guideReportMatches = Boolean(report) && needCert.length > 0 && needCert.every((r) => r.inGuideReport === true);
  const source = {
    guideReportedAt: sheet.guideExpensesAt ? new Date(sheet.guideExpensesAt).toISOString() : null,
    guideReportMatches,
    guideReportedAvailable: guideReportMatches,
    guideReportedReason: !sheet.guideExpensesAt
      ? "ไกด์ไม่ได้ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตน"
      : guideReportMatches ? null : "รายการในใบงานไม่ตรงกับที่ไกด์รายงาน",
    suggested: (guideReportMatches ? "GUIDE_REPORTED" : "ADMIN_RECORDED") as ExpenseSource,
  };

  const out = (status: CampaignStatus, extra: Partial<Classification> = {}): Classification => ({
    jobSheetId: sheet.id,
    status,
    completed: status === "LINKED" || (status === "NOT_REQUIRED" && Boolean(extra.confirmed)),
    confirmed: false,
    reopened,
    reasons,
    rows,
    certifiable,
    activeCertificate: active.length === 1 ? { id: active[0].id, certificateNo: active[0].certificateNo, status: active[0].status } : null,
    snapshotHash,
    review: review ? {
      decision: String(review.decision), current,
      reasonCode: review.reasonCode ?? null, note: review.note ?? null,
      decidedByName: review.decidedByName ?? null,
      decidedAt: review.decidedAt ? new Date(review.decidedAt).toISOString() : null,
      version: review.version ?? 0,
    } : null,
    suggestedNotRequiredReason: null,
    certificatePath: [],
    optInCount: live.filter((r) => r.optIn && !r.requested && r.issues.length === 0).length,
    source,
    ...extra,
  });

  // ── certificates ─────────────────────────────────────────────────────────
  if (active.length > 1) {
    reasons.push(`ใบงานนี้มีใบรับรองที่ยังไม่ยกเลิก ${active.length} ใบ (${active.map((c) => c.certificateNo).join(", ")}) ต้องเหลือใบเดียว`);
    return out("NEEDS_REVIEW");
  }
  if (active.length === 1) {
    const cert = active[0];
    if (cert.status === "LINKED") {
      const problems: string[] = [];
      const covered = Array.isArray(cert.coveredRows) ? (cert.coveredRows as { identity?: string; description?: string }[]) : [];
      for (const c of covered) {
        const hit = live.filter((r) => r.identity === c.identity);
        if (hit.length !== 1 || hit[0].certificateId !== cert.id) {
          problems.push(`"${c.description ?? "รายการ"}" ที่ใบรับรองครอบคลุม ไม่ได้ชี้กลับมาที่ ${cert.certificateNo}`);
        }
      }
      for (const r of live) {
        if (r.evidence === "NEEDS_CERTIFICATE") problems.push(`"${r.description || "รายการ"}" เป็นเงินที่ไกด์สำรองจ่าย ไม่มีหลักฐาน และ ${cert.certificateNo} ไม่ครอบคลุม`);
        if (r.certificateId && r.certificateId !== cert.id) problems.push(`"${r.description || "รายการ"}" ชี้ไปที่ใบรับรองอื่น ไม่ใช่ ${cert.certificateNo}`);
        if (r.evidence === "BROKEN") problems.push(...r.issues.filter((i) => i.startsWith("ใบรับรอง")));
      }
      if (dupes.length) problems.push("มีแถวที่ซ้ำกันจนแยกไม่ได้");
      if (problems.length) { reasons.push(...problems); return out("NEEDS_REVIEW"); }
      return out("LINKED");
    }
    if (cert.status === "STALE") {
      reasons.push(`${cert.certificateNo}: เอกสารใน Drive เปลี่ยนไปแล้ว ใช้เป็นหลักฐานไม่ได้ ต้องจัดเก็บใหม่หรือยกเลิก`);
      return out("NEEDS_REVIEW");
    }
    reasons.push(`${cert.certificateNo} อยู่ระหว่างดำเนินการ (${cert.status}) ยังไม่ใช่หลักฐานจนกว่าจะ LINKED`);
    return out("IN_PROGRESS");
  }

  // ── no certificate ───────────────────────────────────────────────────────
  for (const r of live) for (const i of r.issues) reasons.push(`แถว ${r.index + 1} "${r.description || "รายการ"}": ${i}`);
  if (reopened) reasons.unshift("ใบงานเปลี่ยนหลังจากที่ ADMIN ตัดสินว่าไม่ต้องใช้ใบรับรอง ต้องตรวจใหม่");
  if (reasons.length) return out("NEEDS_REVIEW");

  if (needCert.length === 0) {
    // The guide said they spent money the sheet does not carry. Nothing on the sheet
    // needs a certificate only because nobody wrote the figures down — that is missing
    // data, not a job that needs no evidence.
    const unrecorded = unrecordedReportLines(report, live);
    if (unrecorded.length) {
      for (const g of unrecorded) reasons.push(`ไกด์รายงาน "${g.description}" ${g.pax ?? "?"}×${g.price ?? "?"} = ${bahtText(g.amountSatang)} บาท แต่ใบงานไม่มียอดของรายการนี้ — บันทึกจำนวนและ Paid By ใน Job Sheet ก่อน`);
      return out("NEEDS_REVIEW");
    }
    const confirmed = Boolean(review && review.decision === "NOT_REQUIRED" && current);
    return out("NOT_REQUIRED", { confirmed, completed: confirmed, suggestedNotRequiredReason: suggestReason(live), certificatePath: pathToCertificate(live, sheet) });
  }

  if ((sheet.approvalStatus ?? "") !== "APPROVED") {
    reasons.push("ใบงานยังไม่ได้อนุมัติ ต้องอนุมัติใน Job Sheet ก่อนออกใบรับรอง");
    return out("NEEDS_REVIEW");
  }
  return out("READY_TO_ISSUE");
}

/** Lines in the guide's own report, with an amount, that no used row on the sheet describes. */
function unrecordedReportLines(report: Expense[] | null, live: RowAnalysis[]) {
  if (!report) return [];
  const onSheet = new Set(live.map((r) => text(r.description)));
  return report
    .filter((g) => !isReviewExpense(g) && expenseAmount(g) > 0 && !onSheet.has(text(g.description)))
    .map((g) => ({ description: (g.description ?? "").trim(), price: num(g.price), pax: num(g.pax), amountSatang: satang(expenseAmount(g)) }));
}

/**
 * What would make a NOT_REQUIRED job one that carries a certificate — for a person to act
 * on. A certificate covers the guide's own money with an amount; it is never issued for
 * zero or for nothing, so a sheet with no such row says where the figures have to come from.
 */
function pathToCertificate(live: RowAnalysis[], sheet: CampaignSheet): string[] {
  const steps: string[] = [];
  const optable = live.filter((r) => r.optIn && !r.requested);
  if (optable.length) {
    const waived = optable.filter((r) => r.optIn === "WAIVED"), receipted = optable.filter((r) => r.optIn === "HAS_RECEIPT");
    if (waived.length) steps.push(`${waived.length} รายการเป็นเงินที่ไกด์จ่ายเองและมีเพียงการยกเว้นของ ADMIN แบบเดิม (ไม่มีใบรับรอง) — เลือกรายการที่จะให้ใบรับรองครอบคลุมด้านล่าง`);
    if (receipted.length) steps.push(`${receipted.length} รายการมีใบเสร็จแนบอยู่แล้ว — เลือกได้ แต่ต้องยืนยันว่าต้องการใบรับรองซ้ำกับใบเสร็จ`);
  } else if (!live.length) {
    steps.push("ใบงานนี้ไม่มียอดค่าใช้จ่าย (ทุกแถวไม่มีจำนวน) จึงออกใบรับรองไม่ได้ — ห้ามออกใบรับรองยอดศูนย์");
    steps.push("ถ้าไกด์จ่ายเงินจริง ให้ถามไกด์แล้วบันทึกจำนวนและ Paid By = ไกด์จ่ายเอง ใน Job Sheet จากนั้นกลับมาที่หน้านี้");
  } else if (live.every((r) => r.storedPayer !== "GUIDE_PERSONAL")) {
    steps.push("ทุกรายการที่มียอดบันทึกว่าไม่ใช่เงินไกด์ (บริษัทจ่ายตรงหรือเงินทดรอง) ใบรับรองแทนใบเสร็จใช้กับเงินที่ไกด์สำรองจ่ายเท่านั้น");
    steps.push("ถ้า Paid By ไม่ถูกต้อง แก้ใน Job Sheet พร้อมเหตุผล แล้วกลับมาที่หน้านี้");
  }
  if (steps.length && (sheet.approvalStatus ?? "") !== "APPROVED") steps.push("ใบงานยังไม่ได้อนุมัติ — ต้องอนุมัติใน Job Sheet ก่อนสร้างร่างใบรับรอง");
  return steps;
}

/** The reason the data points at, for an admin to accept or change. Never applied by itself. */
function suggestReason(live: RowAnalysis[]): NotRequiredReason {
  if (!live.length) return "NO_EXPENSES";
  if (live.every((r) => r.storedPayer === "COMPANY_DIRECT")) return "COMPANY_DIRECT";
  if (live.every((r) => r.storedPayer === "GUIDE_ADVANCE")) return "COMPANY_ADVANCE";
  const guide = live.filter((r) => r.storedPayer === "GUIDE_PERSONAL");
  if (guide.length && guide.every((r) => r.evidence === "HAS_RECEIPT") && live.every((r) => r.storedPayer !== "UNSPECIFIED")) return "HAS_RECEIPT";
  return "NO_UNEVIDENCED_REIMBURSEMENT";
}

/** Totals for the page header, by status. */
export function summarize(all: readonly Classification[]) {
  const by = Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, { jobs: 0, rows: 0, totalSatang: 0 }])) as Record<CampaignStatus, { jobs: number; rows: number; totalSatang: number }>;
  let completed = 0, notRequiredConfirmed = 0, notRequiredCandidates = 0, reviewed = 0, reopened = 0;
  for (const c of all) {
    const b = by[c.status];
    b.jobs++;
    // The rows and money that are the evidence question on this job: those a certificate
    // covers or would have to cover.
    const relevant = c.rows.filter((r) => r.evidence === "NEEDS_CERTIFICATE" || r.evidence === "CERTIFIED" || r.evidence === "BROKEN"
      || (r.evidence !== "UNUSED" && r.storedPayer === "GUIDE_PERSONAL" && r.evidence !== "HAS_RECEIPT" && r.evidence !== "WAIVED")
      || (r.evidence !== "UNUSED" && r.issues.length > 0));
    b.rows += relevant.length;
    b.totalSatang += relevant.reduce((t, r) => t + r.amountSatang, 0);
    if (c.completed) completed++;
    if (c.status === "NOT_REQUIRED") { if (c.confirmed) notRequiredConfirmed++; else notRequiredCandidates++; }
    if (c.review?.current) reviewed++;
    if (c.reopened) reopened++;
  }
  return { total: all.length, completed, reviewed, reopened, notRequiredConfirmed, notRequiredCandidates, byStatus: by };
}
