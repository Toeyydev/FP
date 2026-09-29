// The transfer itself: what the bank sees, what comes back from it, and what state the
// document is in while that happens. Pure — no database, no PEAK, no Drive.
//
// The order this enforces is the point. A guide's money used to leave the bank first and
// acquire a PEAK document afterwards, if anyone remembered; the EXP number was typed by
// hand from one screen into another. So FolkOPS now creates the document FIRST and hands
// the operator the exact note to paste into the bank, and the transfer is recorded only
// against a document that already exists, is still open, and still says the same figures.
//
// One transfer, one document, one slip, one bank reference.

import { thb } from "@/lib/jobsheet";
import type { PaymentLineTrace } from "@/lib/peak-payment-document";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Longest bank reference payments-v2 will store (GuidePayment.bankRef). */
export const MAX_BANK_REF = 120;

/** What the slip's amount and reference were checked against. Never "OCR" — a person read them. */
export const VERIFICATION_SOURCE = "USER_VERIFIED_SLIP";
/** What the operator ticks before recording a transfer. */
export const VERIFY_CHECKBOX_TH = "ตรวจสอบยอดและเลขรายการจากสลิปแล้ว";
/** How a recorded transfer's verification is described afterwards. */
export const VERIFIED_LABEL_TH = "ตรวจสอบโดยผู้ใช้งานจากสลิป";

/**
 * One transfer reference, spelled one way.
 *
 * Banks print the same reference with different spacing, and people retype it with
 * different case, so "trbs 2609 23xx" and "TRBS260923XX" are one transfer, not two. The
 * raw text is kept as the operator typed it; THIS is what is compared and made unique.
 * Hyphens and slashes are left alone — they are part of some banks' references.
 */
export function normalizeBankRef(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[\s\u200B-\u200D\uFEFF]+/g, "").toUpperCase();
}

/**
 * Which BANK ACCOUNT a transfer left from, as one comparable string.
 *
 * `paymentMethodId` is PEAK's id for a payment *channel*, not for an account: PEAK
 * returns `bankName` and `accountNumber` on it, and nothing in PEAK's model stops two
 * channels — a transfer and a QR, say — pointing at the same account. A reference is
 * unique within a BANK, so keying uniqueness on the channel would let the same transfer
 * be recorded twice by choosing the other channel.
 *
 * So the account number decides when PEAK gives one, reduced to its digits because the
 * same account is written with and without hyphens. When PEAK gives none, the channel id
 * is the best identity available and is marked as such, so the two can never collide.
 */
export function bankAccountKey(method: { id: string; accountNumber?: string | null } | null | undefined): string | null {
  const digits = (method?.accountNumber ?? "").replace(/\D+/g, "");
  if (digits) return `ACC:${digits}`;
  const id = (method?.id ?? "").trim();
  return id ? `PM:${id}` : null;
}

/**
 * The reference as it is stored and shown: trimmed and upper-cased, but with the spacing
 * the bank prints left in, so an operator comparing the screen to the slip sees the same
 * thing. `normalizeBankRef` is the stricter form underneath it, used only for comparing.
 */
export function displayBankRef(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

// ── What the operator pastes into the bank ───────────────────────────────────

/**
 * The memo that goes on the transfer: the PEAK document first, then the FolkOPS
 * payment. Both, in this order, because the accountant reconciles from the EXP and
 * FolkOPS reconciles from the FOLK-PAY — and a slip that carries only one of them
 * leaves the other side searching by amount and date.
 */
export function bankNote(documentNo: string | null | undefined, paymentRef: string): string {
  const exp = (documentNo ?? "").trim();
  return exp ? `${exp} ${paymentRef}` : paymentRef;
}

/** Filename-safe: letters, digits and hyphens survive; everything else becomes one hyphen. */
const slug = (s: string) => (s ?? "").trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

/** `1876` and `1876.5` both file as `1876.00` / `1876.50` — one amount, one spelling. */
const amountPart = (n: number) => round2(n).toFixed(2);

/**
 * The real extension of what was uploaded — never a guess.
 *
 * A PDF renamed `.jpeg` is a file that will not open, and the name is the only thing
 * anyone sees in a Drive folder. The uploaded filename's own extension is trusted when
 * it is plausible; otherwise the type the browser sent decides.
 */
export function slipExtension(originalName: string | null | undefined, mime: string | null | undefined): string {
  const fromName = (originalName ?? "").trim().toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] ?? "";
  if (fromName && /^(jpe?g|png|webp|heic|heif|gif|pdf|tiff?)$/.test(fromName)) return fromName === "jpg" ? "jpg" : fromName;
  const m = (mime ?? "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic") || m.includes("heif")) return "heic";
  if (m.includes("tiff")) return "tiff";
  return "jpg";
}

/**
 * `<EXP>_<FOLK-PAY>_<GUIDE_ID>_<NET>_<BANK_REF>.<original extension>`
 *
 * Every field someone would otherwise have to open the file to learn. Underscores
 * separate the fields and hyphens live inside them, so the name splits cleanly. The
 * amount is fixed at two decimals with no thousands separator, and the bank reference
 * is the normalised one, so a folder sorts and searches predictably.
 *
 * The extension is whatever the file really is: renaming a PDF to `.jpeg` would make it
 * unopenable, and the guide's name is not in the name — the screen shows that.
 */
export function slipFileName(p: {
  documentNo: string | null | undefined;
  paymentRef: string;
  guideId: string;
  net: number;
  bankRef: string;
  ext: string;
}): string {
  const parts = [slug(p.documentNo ?? "") || "NO-EXP", slug(p.paymentRef), slug(p.guideId), amountPart(p.net), slug(normalizeBankRef(p.bankRef)) || "NO-REF"];
  return `${parts.join("_")}.${slug(p.ext).toLowerCase() || "jpg"}`;
}

// ── The figures, from the document's own lines ───────────────────────────────

export type TransferFigures = {
  gross: number;          // Σ every line — what the document books
  reimbursement: number;  // the guide's own money coming back, never withheld on
  whtBase: number;        // Σ the lines withholding was taken on
  wht: number;            // Σ withholding
  net: number;            // what the bank must send
};

/**
 * Read back from the trace stored with the document, not recomputed from job sheets:
 * these are the figures PEAK was actually given.
 *
 * The withholding base is the sum of the lines that carry withholding, rather than
 * "the fee" — so when a review incentive becomes part of the base, this number follows
 * without being told twice.
 */
export function transferFigures(doc: { lines: unknown; total: number }): TransferFigures {
  const traces = (Array.isArray(doc.lines) ? doc.lines : []) as PaymentLineTrace[];
  const sum = (pick: (t: PaymentLineTrace) => number) => round2(traces.reduce((s, t) => s + (Number(pick(t)) || 0), 0));
  return {
    gross: sum((t) => t.price),
    reimbursement: sum((t) => (t.kind === "REIMBURSEMENT" ? t.price : 0)),
    whtBase: sum((t) => ((Number(t.wht) || 0) > 0 ? t.price : 0)),
    wht: sum((t) => t.wht),
    net: round2(Number(doc.total) || 0),
  };
}

// ── Evidence of the transfer ─────────────────────────────────────────────────

export type TransferEvidence = {
  bankRef: string;
  /** The amount printed on the slip, as the operator read it. */
  slipAmount: number | null;
  hasSlip: boolean;
  /** The operator states they checked the amount and the reference against the slip. */
  verified: boolean;
};

const near = (a: number, b: number) => Math.abs(a - b) <= 0.005;

/**
 * Every reason the transfer cannot be recorded yet.
 *
 * The slip's amount is typed, not read from the image: nothing in FolkOPS does OCR
 * (`lib/kbiz-slip` parses text a bank gives us, not a photograph). Typing it is still
 * worth doing — it is a second person-made statement of the amount, made while looking
 * at the slip, and it catches the transfer that went out at the wrong figure before the
 * document is settled rather than at the next audit.
 */
export function checkTransferEvidence(e: TransferEvidence, net: number): string[] {
  const reasons: string[] = [];
  const bankRef = normalizeBankRef(e.bankRef);
  if (!bankRef) reasons.push("Enter the bank reference from the slip — the transfer cannot be traced without it");
  else if (bankRef.length > MAX_BANK_REF) reasons.push(`The bank reference is longer than ${MAX_BANK_REF} characters`);
  if (!e.hasSlip) reasons.push("Attach the payment slip");
  if (e.slipAmount == null) reasons.push("Enter the amount printed on the slip");
  else if (!near(e.slipAmount, net)) {
    reasons.push(`The slip says ${thb(e.slipAmount)} but this document is for ${thb(net)} — nothing was recorded. Transfer the difference, or void the document in PEAK and create one for what was actually sent`);
  }
  // The figures above were typed by a person, so a person has to say they checked them.
  // That statement is what the audit trail records as the source of the verification.
  if (!e.verified) reasons.push("Tick to confirm you have checked the amount and the reference against the slip");
  return reasons;
}

// ── Where the document stands ────────────────────────────────────────────────

export type TransferStage =
  | "WAITING_FOR_PEAK"
  | "PEAK_CREATED"
  | "READY_TO_TRANSFER"
  | "EVIDENCE_UPLOADED"
  | "PAID"
  | "PEAK_DRIFT"
  | "PEAK_VOIDED"
  | "FAILED";

export const STAGE_LABEL: Record<TransferStage, string> = {
  WAITING_FOR_PEAK: "Waiting for PEAK",
  PEAK_CREATED: "PEAK created",
  READY_TO_TRANSFER: "Ready to transfer",
  EVIDENCE_UPLOADED: "Transfer evidence uploaded",
  PAID: "Paid",
  PEAK_DRIFT: "PEAK drift",
  PEAK_VOIDED: "PEAK voided",
  FAILED: "Not created",
};

/**
 * One name for where a payment stands, from the stored row plus whatever the caller
 * has checked.
 *
 * "PEAK created" and "Ready to transfer" are deliberately different things. The first
 * says a document exists. The second says a server checked it just now — still open in
 * PEAK, still for these figures — and it is the only state in which the bank note and
 * the amount are worth showing. Nobody should transfer against a number that was true
 * when the screen loaded.
 */
export function transferStage(doc: {
  status: string;
  peakDocumentNo?: string | null;
  slipUrl?: string | null;
  bankRef?: string | null;
}, checked?: { drift?: boolean; peakOpen?: boolean }): TransferStage {
  const s = (doc.status ?? "").toUpperCase();
  if (s === "PAID" || s === "POSTED") return "PAID";
  if (s === "VOIDED") return "PEAK_VOIDED";
  if (s === "FAILED") return "FAILED";
  if (s === "PAYING" || s === "PAYMENT_UNCERTAIN") {
    return (doc.slipUrl ?? "").trim() || (doc.bankRef ?? "").trim() ? "EVIDENCE_UPLOADED" : "WAITING_FOR_PEAK";
  }
  if (s === "CREATING" || s === "CREATE_UNCERTAIN" || s === "POSTING" || s === "UNCERTAIN") return "WAITING_FOR_PEAK";
  // AWAITING_PAYMENT — the document exists.
  if (checked?.drift) return "PEAK_DRIFT";
  if (checked?.peakOpen === false) return "PEAK_VOIDED";
  if (!(doc.peakDocumentNo ?? "").trim()) return "WAITING_FOR_PEAK";
  return checked?.peakOpen ? "READY_TO_TRANSFER" : "PEAK_CREATED";
}

/** Only a checked, drift-free document may be transferred against. */
export const canTransfer = (stage: TransferStage) => stage === "READY_TO_TRANSFER";

// ── The payload fingerprint ──────────────────────────────────────────────────

/**
 * A short fingerprint of exactly what was sent to PEAK, stored with the document.
 *
 * `lib/payment-document-drift` already compares figures job by job and says what moved,
 * which is what an operator needs to read. This is the cruder check underneath it: if
 * the payload FolkOPS would build today hashes differently from the one PEAK was given,
 * something changed that the figure comparison may not model — a line's account, a
 * description, the order of the jobs — and the document should be voided and remade
 * rather than paid.
 *
 * Not a security primitive: a 32-bit FNV-1a rendered as 8 hex characters, the same
 * change-detector `lib/peak-sync` uses for job sheets.
 */
export function paymentPayloadHash(expense: unknown): string {
  return fnv1a(stable(expense));
}

/** JSON with object keys in a fixed order, so an unchanged payload always hashes alike. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
