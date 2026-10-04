// Does this slip show the transfer being recorded, to the guide it is recorded for?
//
// Pure — no database, no file. The slip is read by lib/advances/slip-read; the guide's
// names and (decrypted) account number are loaded by lib/advances/slip-check. This only
// compares, and says exactly what it compared.
//
//   MATCH     the recipient's first AND last name match the guide in full, the visible
//             account digits match the guide's account, and the reference, amount and
//             date on the slip are the ones typed. Recorded without further questions.
//   PARTIAL   something matches and nothing contradicts — a bank-truncated surname, one
//             name only, no account on file. A person confirms, with a reason.
//   MISMATCH  something contradicts: another account, another name, another guide's
//             name, a different reference, amount or date. Refused unless an ADMIN
//             overrides, with a reason.
//   UNKNOWN   the slip could not be read (a photo, another bank). A person checks it by
//             eye and confirms.
//
// One matching word is never a MATCH: a first name and the start of a surname, printed for
// a guide whose surname runs on for many more letters, is PARTIAL — a bank truncating a
// surname and two people sharing a first name look the same from here.
import { differsByBuddhistEra } from "@/lib/ce-date";
import type { SlipRead } from "@/lib/advances/slip-read";
import { txRefKey } from "@/lib/advances/tx-ref";

export type SlipResult = "MATCH" | "PARTIAL" | "MISMATCH" | "UNKNOWN";
export type FactCheck = "SAME" | "DIFFERENT" | "NOT_ON_SLIP";
export type NameCheck = "FULL" | "TRUNCATED" | "ONE_NAME" | "NONE" | "CANNOT_COMPARE";
export type AccountCheck = "MATCH" | "MISMATCH" | "CANNOT_COMPARE";

export type GuideIdentity = {
  guideId: string;
  /** Full names as held: Thai, English, the legacy full name, the bank account holder name. Never the nickname. */
  names: (string | null | undefined)[];
  /** Account number, digits only once compared; null when none is on file. */
  accountNo: string | null;
};

export type SlipChecks = {
  transactionId: FactCheck;
  amount: FactCheck;
  date: FactCheck;
  name: NameCheck;
  account: AccountCheck;
  /** Another guide whose full name or account this slip shows instead. */
  otherGuideId: string | null;
};

export type SlipCheck = {
  result: SlipResult;
  checks: SlipChecks | null;
  /** Why, in Thai and English — what the screen shows. */
  reasons: string[];
  /** What the slip shows, for the person checking. Names are shown, never stored. */
  slip: { transactionId: string | null; date: string | null; amount: number | null; recipientNames: string[]; accountMask: string | null } | null;
  /** Why the slip could not be read, when it could not. */
  unreadable: string | null;
};

const TH = /[฀-๿]/;
// Titles printed before a name — often glued to it ("นายสมชาย", "MR.SOMCHAI"). Stripped
// the same way from the slip and from the names held, so a name that happens to begin
// with the same letters is cut identically on both sides and still compares.
const TITLE = /^(?:(?:นางสาว|นาง|นาย|น\.\s?ส\.?|ด\.\s?ช\.?|ด\.\s?ญ\.?|คุณ)|(?:MRS|MR|MS|MISS|MSTR|DR)(?=[.\s]))\s*\.?\s*/i;

/** Name tokens, titles removed, upper case; parenthesised nicknames dropped. */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let s = raw.normalize("NFC").replace(/\([^)]*\)/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  for (let i = 0; i < 2; i++) { const m = s.match(TITLE); if (!m || m[0].length >= s.length) break; s = s.slice(m[0].length).trim(); }
  return s.split(/[\s.,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
}

const scriptOf = (tokens: string[]) => (tokens.some((t) => TH.test(t)) ? "th" : "latin");

/** How one printed name compares with one held name (same script). */
export function compareName(slipTokens: string[], heldTokens: string[]): Exclude<NameCheck, "CANNOT_COMPARE"> {
  if (!slipTokens.length || !heldTokens.length) return "NONE";
  const first = slipTokens[0] === heldTokens[0];
  const sl = slipTokens[slipTokens.length - 1], hl = heldTokens[heldTokens.length - 1];
  if (heldTokens.length >= 2 && slipTokens.length === heldTokens.length && slipTokens.every((t, i) => t === heldTokens[i])) return "FULL";
  // A bank prints long names cut short: the first name in full and the surname's start,
  // or every word's start. Each printed word must begin the held word in its place, and
  // none may be shorter than three letters.
  if (first && slipTokens.length >= 2 && heldTokens.length >= 2 && sl.length >= 3 && sl.length < hl.length && hl.startsWith(sl)) return "TRUNCATED";
  if (slipTokens.length === heldTokens.length && slipTokens.length >= 2
    && slipTokens.every((t, i) => t.length >= 3 && heldTokens[i].startsWith(t)) && slipTokens.some((t, i) => t.length < heldTokens[i].length)) return "TRUNCATED";
  if (slipTokens.some((t) => heldTokens.includes(t))) return "ONE_NAME";
  return "NONE";
}

const RANK: Record<NameCheck, number> = { FULL: 4, TRUNCATED: 3, ONE_NAME: 2, NONE: 1, CANNOT_COMPARE: 0 };

/** The best comparison of the slip's recipient lines against a guide's names. */
export function bestName(slipNames: string[], held: (string | null | undefined)[]): NameCheck {
  let best: NameCheck = "CANNOT_COMPARE";
  for (const line of slipNames) {
    const st = nameTokens(line);
    if (!st.length) continue;
    for (const h of held) {
      const ht = nameTokens(h);
      if (!ht.length || scriptOf(ht) !== scriptOf(st)) continue;
      const r = compareName(st, ht);
      if (RANK[r] > RANK[best]) best = r;
    }
  }
  return best;
}

/** Visible digits of a printed mask against an account number, position by position. */
export function compareAccount(mask: string | null, accountNo: string | null): AccountCheck {
  if (!mask || !accountNo) return "CANNOT_COMPARE";
  const m = mask.replace(/[\s-]/g, "");
  const a = accountNo.replace(/\D/g, "");
  if (!a || m.length !== a.length) return "CANNOT_COMPARE";
  let visible = 0;
  for (let i = 0; i < m.length; i++) {
    if (/\d/.test(m[i])) { visible++; if (m[i] !== a[i]) return "MISMATCH"; }
  }
  return visible >= 3 ? "MATCH" : "CANNOT_COMPARE";
}

const fact = <T>(onSlip: T | null, typed: T | null, same: (a: T, b: T) => boolean): FactCheck =>
  onSlip == null || typed == null ? "NOT_ON_SLIP" : same(onSlip, typed) ? "SAME" : "DIFFERENT";

export type Typed = { txRef: string | null; amount: number | null; advanceDate: string | null };

/** Compare a read slip with what was typed and with the selected guide (and the others). */
export function checkSlip(read: SlipRead | null, unreadable: string | null, typed: Typed, guide: GuideIdentity, others: GuideIdentity[]): SlipCheck {
  if (!read) {
    return {
      result: "UNKNOWN", checks: null, slip: null, unreadable: unreadable ?? "the slip could not be read",
      reasons: [
        `อ่าน slip อัตโนมัติไม่ได้ (${unreadable ?? "unreadable"}) — ตรวจชื่อผู้รับ เลขบัญชี ยอด วันที่ และเลขอ้างอิงด้วยตาเอง แล้วยืนยัน`,
        `The slip could not be read (${unreadable ?? "unreadable"}). Check the recipient, account, amount, date and reference by eye, then confirm.`,
      ],
    };
  }
  const checks: SlipChecks = {
    transactionId: fact(txRefKey(read.transactionId), txRefKey(typed.txRef), (a, b) => a === b),
    amount: fact(read.amount, typed.amount, (a, b) => Math.round(a * 100) === Math.round(b * 100)),
    date: fact(read.transferDate, typed.advanceDate, (a, b) => a === b),
    name: bestName(read.recipient.names, guide.names),
    account: compareAccount(read.recipient.accountMask, guide.accountNo),
    otherGuideId: null,
  };
  // The slip is someone else's: another guide's full name or account, and not this one's.
  if (checks.name !== "FULL" && checks.account !== "MATCH") {
    const other = others.find((o) => o.guideId !== guide.guideId &&
      (bestName(read.recipient.names, o.names) === "FULL" || compareAccount(read.recipient.accountMask, o.accountNo) === "MATCH"));
    if (other) checks.otherGuideId = other.guideId;
  }

  const th: string[] = [], en: string[] = [];
  const say = (t: string, e: string) => { th.push(t); en.push(e); };
  if (checks.transactionId === "DIFFERENT") say("เลขอ้างอิงบน slip ไม่ตรงกับที่กรอก", "The reference on the slip is not the one typed.");
  if (checks.amount === "DIFFERENT") say("ยอดบน slip ไม่ตรงกับที่กรอก", "The amount on the slip is not the one typed.");
  if (checks.date === "DIFFERENT") {
    if (differsByBuddhistEra(typed.advanceDate, read.transferDate)) say(`ปีที่กรอก (${typed.advanceDate?.slice(0, 4)}) เป็นปี พ.ศ. — ช่องวันที่ใช้ ค.ศ. (${read.transferDate?.slice(0, 4)}) แก้ปีแล้วตรวจใหม่`, `The year typed (${typed.advanceDate?.slice(0, 4)}) is the Buddhist-era year — the date field is Gregorian (${read.transferDate?.slice(0, 4)}). Fix the year.`);
    else say("วันที่โอนบน slip ไม่ตรงกับที่กรอก", "The transfer date on the slip is not the one typed.");
  }
  if (checks.account === "MISMATCH") say("เลขบัญชีปลายทางบน slip ไม่ใช่บัญชีของไกด์คนนี้", "The destination account on the slip is not this guide's account.");
  if (checks.otherGuideId) say(`slip นี้ดูเป็นของ ${checks.otherGuideId}`, `This slip looks like a transfer to ${checks.otherGuideId}.`);
  if (checks.name === "NONE") say("ชื่อผู้รับบน slip ไม่ตรงกับชื่อไกด์", "The recipient's name on the slip does not match this guide.");
  const contradicted = checks.transactionId === "DIFFERENT" || checks.amount === "DIFFERENT" || checks.date === "DIFFERENT"
    || checks.account === "MISMATCH" || !!checks.otherGuideId || checks.name === "NONE";

  const slip = { transactionId: read.transactionId, date: read.transferDate, amount: read.amount, recipientNames: read.recipient.names, accountMask: read.recipient.accountMask };
  if (contradicted) return { result: "MISMATCH", checks, slip, unreadable: null, reasons: [...th, ...en] };

  const factsSame = checks.transactionId === "SAME" && checks.amount === "SAME" && checks.date === "SAME";
  if (checks.name === "FULL" && checks.account === "MATCH" && factsSame) {
    return { result: "MATCH", checks, slip, unreadable: null, reasons: ["ชื่อ-นามสกุล เลขบัญชี ยอด วันที่ และเลขอ้างอิงตรงกับที่บันทึก", "Name, account, amount, date and reference all match."] };
  }
  if (checks.name === "TRUNCATED") say("นามสกุลบน slip ถูกตัดสั้น ตรงเพียงส่วนต้น", "The surname on the slip is cut short and matches only its beginning.");
  if (checks.name === "ONE_NAME") say("ชื่อบน slip ตรงเพียงคำเดียว", "Only one word of the name on the slip matches.");
  if (checks.name === "CANNOT_COMPARE") say("ไม่มีชื่อเต็มของไกด์ในภาษาเดียวกับ slip ให้เทียบ", "No full name of this guide in the slip's script to compare with.");
  if (checks.account === "CANNOT_COMPARE") say("เทียบเลขบัญชีไม่ได้ (ไม่มีเลขบัญชีของไกด์ในระบบ หรือรูปแบบต่างกัน)", "The account could not be compared (no account on file for this guide, or a different format).");
  if (checks.transactionId === "NOT_ON_SLIP" || checks.amount === "NOT_ON_SLIP" || checks.date === "NOT_ON_SLIP") say("อ่านเลขอ้างอิง ยอด หรือวันที่จาก slip ได้ไม่ครบ", "The reference, amount or date could not all be read from the slip.");
  const positive = checks.name === "FULL" || checks.name === "TRUNCATED" || checks.name === "ONE_NAME" || checks.account === "MATCH";
  return { result: positive ? "PARTIAL" : "UNKNOWN", checks, slip, unreadable: null, reasons: [...th, ...en] };
}

/** What is kept on the advance: results and masked digits only — no names. */
export type StoredSlipDetail = {
  checks: SlipChecks | null;
  accountMask: string | null;
  transactionId: string | null;
  date: string | null;
  amount: number | null;
  unreadable: string | null;
};
export const storedDetail = (c: SlipCheck): StoredSlipDetail => ({
  checks: c.checks, accountMask: c.slip?.accountMask ?? null, transactionId: c.slip?.transactionId ?? null,
  date: c.slip?.date ?? null, amount: c.slip?.amount ?? null, unreadable: c.unreadable,
});

export const MIN_SLIP_REASON = 10;

export type SlipDecision = { confirmed: boolean; override: boolean; reason: string | null };

/**
 * May the advance be recorded with this result, and this person's answer? Null when it
 * may; otherwise the refusal, in both languages.
 */
export function slipGate(result: SlipResult, decision: SlipDecision, role: string | null | undefined): string[] | null {
  const reason = (decision.reason ?? "").trim();
  if (result === "MATCH") return null;
  if (result === "PARTIAL") {
    if (decision.confirmed && reason.length >= MIN_SLIP_REASON) return null;
    return ["slip ตรงบางส่วน — ติ๊กยืนยันว่าตรวจแล้ว และเขียนเหตุผล (อย่างน้อย 10 ตัวอักษร)", "The slip only partly matches: tick that you checked it and give a reason (at least 10 characters)."];
  }
  if (result === "UNKNOWN") {
    if (decision.confirmed) return null;
    return ["อ่าน slip ไม่ได้ — ตรวจด้วยตาเองแล้วติ๊กยืนยันก่อนบันทึก", "The slip could not be read: check it by eye and tick to confirm before recording."];
  }
  // MISMATCH
  if (role === "ADMIN" && decision.override && reason.length >= MIN_SLIP_REASON) return null;
  return role === "ADMIN"
    ? ["slip ไม่ตรง — เปลี่ยนไกด์/ข้อมูลให้ถูก หรือ override พร้อมเหตุผล (อย่างน้อย 10 ตัวอักษร)", "The slip does not match: correct the guide or the details, or override with a reason (at least 10 characters)."]
    : ["slip ไม่ตรงกับไกด์หรือข้อมูลที่กรอก — แก้ให้ถูก หรือให้ ADMIN ตรวจและ override", "The slip does not match the guide or the details typed: correct them, or ask an ADMIN to review and override."];
}
