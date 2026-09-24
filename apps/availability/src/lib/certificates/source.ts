// Where the expense rows on a certificate came from.
//
// Two ways, and the difference is not paperwork. It is the difference between a document
// that says a guide reported something and one that says an admin did — who stands
// behind the figures, and therefore who is answerable if they are wrong.
//
//   GUIDE_REPORTED   the guide filed the report from their own account, at a recorded
//                    time. `guideExpensesAt`, and nothing else: `certifiedAt` is the
//                    operator's first save, and an operator pressing Save is not a guide
//                    reporting anything.
//
//   ADMIN_RECORDED   an admin entered the rows from information they checked, and the
//                    document says so in as many words. Two situations wear this label
//                    and they must not be described alike:
//
//                      the guide never filed    the absence is the point, and leaving it
//                                               unsaid invites a reader to assume a
//                                               report exists somewhere
//                      the guide DID file       and the admin used their own checked
//                                               figures instead. Saying "the guide did
//                                               not report" here would be false about a
//                                               person who did.
//
// Chosen once, at issue, and never afterwards. Editing one into the other would rewrite
// what a document already signed claims about a person. Getting it wrong means
// withdrawing the certificate and issuing another, which is what withdrawal is for.

export const EXPENSE_SOURCES = ["GUIDE_REPORTED", "ADMIN_RECORDED"] as const;
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

export const isExpenseSource = (v: unknown): v is ExpenseSource =>
  typeof v === "string" && (EXPENSE_SOURCES as readonly string[]).includes(v);

/** What the picker says, and what the document is about to claim. */
export const SOURCE_LABEL_TH: Record<ExpenseSource, string> = {
  GUIDE_REPORTED: "ไกด์ส่งรายงานผ่านบัญชีของตน",
  ADMIN_RECORDED: "ผู้ดูแลระบบบันทึกแทนจากข้อมูลที่ตรวจสอบแล้ว",
};

/**
 * The sentence the document carries about where the rows came from.
 *
 * Built here rather than in the template so both readings live side by side and neither
 * can quietly drift into implying the other.
 */
export function sourceSentenceTh(input: {
  source: ExpenseSource;
  /**
   * Whether the guide filed a report, AS IT WAS when the certificate was issued.
   *
   * A snapshot, never re-read from the job sheet at render time. A guide who files a
   * week later does not retroactively change what a signed document said about them —
   * and a document whose words could change without its fingerprint changing would not
   * be worth fingerprinting.
   */
  guideReportedAt: string | null;
  recordedByName: string | null;
  recordedAt: string | null;
  /** A draft has not been recorded yet, so it says what WILL be recorded. */
  draft?: boolean;
}, when: (iso: string) => string): string {
  if (input.source === "GUIDE_REPORTED") {
    return input.guideReportedAt
      ? `ไกด์ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนเมื่อ ${when(input.guideReportedAt)}`
      : "ไม่มีบันทึกการส่งรายงานจากบัญชีของไกด์";
  }

  const who = (input.recordedByName ?? "").trim() || "ผู้ดูแลระบบ";
  // A draft has no recording time, and inventing one would be the document's first lie.
  const clause = input.draft || !input.recordedAt
    ? `ผู้ดูแลระบบ ${who} จะเป็นผู้บันทึกรายการจากข้อมูลที่ตรวจสอบแล้วเมื่อยืนยัน`
    : `ผู้ดูแลระบบ ${who} บันทึกรายการจากข้อมูลที่ตรวจสอบแล้วเมื่อ ${when(input.recordedAt)}`;

  // Two different situations, and saying the wrong one is not a wording problem.
  //
  // The guide DID file, and an admin recorded their own checked figures instead. Saying
  // "the guide did not report" there would be false about a person who did — the document
  // says which figures it stands on, and stops.
  //
  // The guide did NOT file. Then the absence is the point, and leaving it unsaid would
  // invite a reader to assume a report exists somewhere.
  return input.guideReportedAt
    ? `${clause} โดยเอกสารฉบับนี้ยึดรายการที่ผู้ดูแลระบบบันทึกไว้`
    : `${clause} โดยไกด์ไม่ได้ส่งรายงานผ่านบัญชีของตนสำหรับใบงานนี้`;
}

export type SourceAvailability = {
  source: ExpenseSource;
  available: boolean;
  /** Why not, in Thai, for a disabled option. */
  reason: string | null;
};

/**
 * Which sources this job sheet allows, and which one to offer first.
 *
 * `GUIDE_REPORTED` needs the guide to have actually filed — there is no version of that
 * claim that can be made on their behalf. `ADMIN_RECORDED` is always available once
 * there are rows to speak for, which is the case this whole option exists for: the guide
 * did not file, the expenses still happened, and the company still has to account for
 * them.
 */
export function availableSources(sheet: { guideExpensesAt: Date | null }): SourceAvailability[] {
  const filed = Boolean(sheet.guideExpensesAt);
  return [
    {
      source: "GUIDE_REPORTED",
      available: filed,
      reason: filed ? null : "ไกด์ยังไม่ได้ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนสำหรับใบงานนี้",
    },
    { source: "ADMIN_RECORDED", available: true, reason: null },
  ];
}

/** The one offered first: the guide's own report when there is one. */
export const defaultSource = (sheet: { guideExpensesAt: Date | null }): ExpenseSource =>
  sheet.guideExpensesAt ? "GUIDE_REPORTED" : "ADMIN_RECORDED";

/** Why this source cannot be used for this sheet, or null. */
export function sourceRefusal(source: ExpenseSource, sheet: { guideExpensesAt: Date | null }): string | null {
  const found = availableSources(sheet).find((s) => s.source === source);
  if (!found) return "ที่มาของรายการไม่ถูกต้อง";
  return found.available ? null : found.reason;
}

/**
 * What an admin is told before choosing to record the rows themselves.
 *
 * Two situations, and the screen must not describe the wrong one — an admin who is told
 * "the guide did not file" about a guide who did has been misled by their own tooling
 * before they put a name to anything.
 */
export function adminRecordedExplainerTh(sheet: { guideExpensesAt: Date | null }): string {
  return sheet.guideExpensesAt
    ? "ไกด์ส่งรายงานผ่านบัญชีของตนแล้ว แต่ผู้ดูแลระบบเลือกใช้รายการที่ตนตรวจสอบและบันทึกไว้ เอกสารจะระบุว่าผู้ดูแลระบบเป็นผู้บันทึกรายการ และยึดรายการที่บันทึกไว้นั้น โดยจะไม่เขียนว่าไกด์ไม่ได้รายงาน"
    : "ไกด์ไม่ได้ส่งรายงานผ่านบัญชีของตนสำหรับใบงานนี้ ผู้ดูแลระบบยังออกใบรับรองได้จากรายการค่าใช้จ่ายที่ตรวจสอบและบันทึกไว้ในใบงานแล้ว โดยเอกสารจะระบุชัดเจนว่าผู้ดูแลระบบเป็นผู้บันทึกรายการ ไม่ใช่ไกด์";
}
