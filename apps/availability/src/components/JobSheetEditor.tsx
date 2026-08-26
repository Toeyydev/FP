"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { computeTotals, EXPENSE_CATEGORIES, expenseAccountingStatus, expenseAmount, expenseCategory, expenseCategoryLabel, fillDownExpensePax, isApproved, isReviewExpense, jobCostBreakdown, noShowStats, noShowStatus, PEAK_SERVICE_COST_LABEL, reviewBelongsToJob, thb, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";
import { advanceStatus, advanceTotals, ADVANCE_STATUS_LABEL, PAYMENT_SOURCES } from "@/lib/advance";
import { canonicalPaidBy, figuresNeedRecheck, jobSheetTotals } from "@/lib/peak-sync";
import { JOB_SHEET_CERTIFIER, CERT_STATEMENT_TH, certificationDate, fmtCertDate } from "@/lib/certifier";
import { JOB_SHEET_COMPANY_INFO as CO } from "@/lib/company";
import { SLOT_TIMES } from "@/lib/slots";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";

const UNIT_OPTIONS = ["คน", "เที่ยว", "ครั้ง"];

type Header = { guideId: string; name: string; email: string; tel: string; taxId: string; address: string; licenseNo?: string; peakContactId?: string | null; peakContactCode?: string | null; peakContactName?: string | null } | null;
type Tour = { id: string; name: string; time: string; durationMin?: number | null; meetingPoint?: string | null } | null;
// Read-only job facts assembled server-side from records that already exist.
type JobMeta = { operator: string | null; ota: string | null; lead: string | null; leadRef: string | null; meetingPoint: string | null } | null;
type HistoryEvent = { at: string; label: string; by?: string | null };
// PEAK readiness, computed server-side (lib/peak-sync). Read-only here: this screen
// never posts to PEAK and never invents a document number.
type PeakRow = null | { mappingStatus: "READY" | "NEEDS_REVIEW" | "UNMAPPED"; disposition: "SYNC" | "ALREADY_RECORDED" | "BLOCKED" };
type PeakInfo = {
  peakSyncStatus: string | null; peakDocumentId: string | null; peakDocumentNo: string | null;
  syncedAt: string | null; syncError: string | null; lastPayloadHash: string | null;
  accountingDate: string | null; documentDate: string | null; paymentDate: string | null;
  accountsConfigured: boolean; contactMapped: boolean; rowsReady: boolean;
  eligibility: { status: "NOT_READY" | "READY" | "SYNCING" | "SYNCED" | "FAILED" | "BLOCKED"; canSync: boolean; reasons: string[]; changedSinceSync: boolean };
  rows: PeakRow[];
} | null;

// Google Calendar "add event" link — opens a pre-filled event the guide saves
// in one tap (Google then sends its own reminders). Bangkok time → UTC.
function gcalUrl(tourName: string, date: string, slotIdx: number, durationMin: number, details: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [H, M] = (SLOT_TIMES[slotIdx] || "09:00").split(":").map(Number);
  const startMs = Date.UTC(y, m - 1, d, H, M) - 7 * 3600 * 1000;
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const dates = `${f(startMs)}/${f(startMs + durationMin * 60000)}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: `Folkpaths tour — ${tourName}`, dates, details });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
type Sheet = {
  ref: string | null; guideId: string; date: string; slotIdx: number; tourId: string; status: string;
  bookings: Booking[]; expenses: Expense[]; guideFee: GuideFee; updatedAt?: string | null;
  guideExpenses?: Expense[] | null; guideExpensesAt?: string | null; guideExpensesNote?: string | null;
  operatorNote?: string | null;
  approvalStatus?: string | null; approvedBy?: string | null; approvedAt?: string | null;
  certifiedAt?: string | null; // first successful save — the certification date (server-stamped, set once)
};
// Advance rows as returned by /api/jobsheet (paidAt on advances, returnedAt on returns).
type AdvanceRow = { id: string; amount: number; paidAt?: string; returnedAt?: string; method: string; txRef?: string | null; peakRef?: string | null; slipUrl?: string | null; note?: string | null };
type AdvanceData = { advances: AdvanceRow[]; returns: AdvanceRow[] };
const dtShort = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
// Bilingual label — English with the Thai accounting term underneath, so the job
// sheet reads as a proper Thai accounting document (accountant-requested).
const TH = ({ en, th }: { en: string; th: string }) => (
  <>{en}<span style={{ display: "block", fontSize: 9.5, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", lineHeight: 1.2 }}>{th}</span></>
);

const numOrNull = (v: string): number | null => { if (v.trim() === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export default function JobSheetEditor() {
  const router = useRouter();
  const sp = useSearchParams();
  const guideId = sp.get("guideId") || "";
  const date = sp.get("date") || "";
  const slotIdx = Number(sp.get("slotIdx") ?? "-1");

  const [header, setHeader] = useState<Header>(null);
  const [tour, setTour] = useState<Tour>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [saved, setSaved] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [checkedIn, setCheckedIn] = useState(false);
  const [payment, setPayment] = useState<{ paid: boolean; paidAt: string | null; slip: string | null; status?: string | null; peakRef?: string | null } | null>(null); // paid state + slip (from the operator)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showFull, setShowFull] = useState(false); // guides see the summary; expand for full sheet
  const [secTab, setSecTab] = useState<"all" | "details" | "expenses" | "fee">("all"); // operator section tabs — "all" keeps the classic single-scroll sheet
  const [drive, setDrive] = useState<{ enabled: boolean; connected: boolean }>({ enabled: false, connected: false }); // Google Drive save
  const [guideExp, setGuideExp] = useState<Expense[]>([]); // guide's own expense report (separate from official)
  const [guideNote, setGuideNote] = useState(""); // free-text note with the guide's report
  const [expBusy, setExpBusy] = useState(false);
  const [fillPax, setFillPax] = useState(""); // "fill down": one guest count → every expense line's pax
  // Guide advance + settlement (cash movements — separate from expenses, see lib/advance)
  const [advance, setAdvance] = useState<AdvanceData>({ advances: [], returns: [] });
  const [advKind, setAdvKind] = useState<null | "advance" | "return">(null); // which record-form is open
  const [advForm, setAdvForm] = useState<{ amount: string; at: string; method: string; txRef: string; note: string; file: File | null }>({ amount: "", at: "", method: "bank", txRef: "", note: "", file: null });
  const [advBusy, setAdvBusy] = useState(false);
  const [showCross, setShowCross] = useState(false); // expand the cross-check again after approval
  const [jobMeta, setJobMeta] = useState<JobMeta>(null); // operator / OTA / lead guest / meeting point
  const [history, setHistory] = useState<HistoryEvent[]>([]); // real recorded events only
  const [histTab, setHistTab] = useState<"timeline" | "files">("timeline");
  const [peak, setPeak] = useState<PeakInfo>(null);
  const [peakAccounts, setPeakAccounts] = useState<{ code: string; name: string }[]>([]);
  const [contactEdit, setContactEdit] = useState<string | null>(null); // inline PEAK-contact mapping
  const [peakContacts, setPeakContacts] = useState<{ id: string; name: string; taxNumber?: string; code?: string }[] | null>(null);
  const [contactsError, setContactsError] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/jobsheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" });
    if (!r.ok) { setMsg("Could not load this job sheet."); return; }
    const d = await r.json();
    setHeader(d.header); setTour(d.tour); setSheet(d.sheet); setSaved(d.saved); setCanEdit(d.canEdit !== false); setCheckedIn(!!d.checkedIn); setPayment(d.payment ?? null);
    setAdvance(d.advance ?? { advances: [], returns: [] });
    setJobMeta(d.jobMeta ?? null); setHistory(Array.isArray(d.history) ? d.history : []); setPeak(d.peak ?? null);
    // Seed the guide's expense report: their last submission if any, else the standard
    // expense lines (with prices) as a starting template to fill in.
    const s = d.sheet as Sheet;
    setGuideExp((s?.guideExpenses && s.guideExpenses.length ? s.guideExpenses : (s?.expenses ?? [])).map((e: Expense) => ({ ...e })));
    setGuideNote(s?.guideExpensesNote ?? "");
  }, [guideId, date, slotIdx]);
  useEffect(() => { if (guideId && date && slotIdx >= 0) load(); }, [load, guideId, date, slotIdx]);
  // Other Tour Cost has no standing account (it covers too many different things),
  // so those rows pick one here. The chart is only fetched when such a row exists —
  // most sheets have none and should not pay for the call.
  const needsAccountPicker = !!sheet?.expenses?.some(
    (e) => !isReviewExpense(e) && expenseCategory(e) === "other" && expenseAmount(e) > 0,
  );
  useEffect(() => {
    if (!needsAccountPicker || !canEdit || peakAccounts.length) return;
    fetch("/api/peak/accounts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.ok && setPeakAccounts(d.accounts ?? []))
      .catch(() => {});
  }, [needsAccountPicker, canEdit, peakAccounts.length]);

  useEffect(() => { fetch("/api/jobsheet/drive").then((r) => (r.ok ? r.json() : null)).then((d) => d && setDrive({ enabled: !!d.enabled, connected: !!d.connected })).catch(() => {}); }, []);

  // Entrance-fee items (Grand Palace, Wat Pho, Wat Arun) are paid only for guests
  // whose tickets are "Included". Keep their pax in sync with that count.
  useEffect(() => {
    setSheet((prev) => {
      if (!prev) return prev;
      // Only sync attraction (ticket) pax to the ticket-included headcount ONCE the
      // operator has started tagging tickets. Until then, every expense pax is the
      // operator's to set (blank defaults + "Fill down"), so we never force it to 0.
      const anyTicketTagged = prev.bookings.some((b) => b.tickets === "included" || b.tickets === "not");
      if (!anyTicketTagged) return prev;
      const ATTRACTIONS = ["grand palace", "wat pho", "wat arun"];
      const inclPax = prev.bookings.reduce((s, b) => s + (b.tickets === "included" ? (b.actualPax ?? b.bookedPax ?? 0) : 0), 0);
      let changed = false;
      const expenses = prev.expenses.map((e) => {
        const isAttraction = ATTRACTIONS.some((a) => e.description.trim().toLowerCase().startsWith(a));
        if (isAttraction && e.pax !== inclPax) { changed = true; return { ...e, pax: inclPax }; }
        return e;
      });
      return changed ? { ...prev, expenses } : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sheet?.bookings?.map((b) => [b.tickets, b.actualPax, b.bookedPax]))]);

  // MUST stay above the `if (!sheet) return` below. React counts hooks per render:
  // an effect placed after that early return does not run while `sheet` is null and
  // does once it loads, which is "Rendered more hooks than during the previous
  // render" — the whole page then dies with a client-side exception.
  // The guides already exist in PEAK, so this is a LINK, not a creation. Fetched
  // only while the mapping control is open — most sheet loads never need it.
  useEffect(() => {
    if (contactEdit === null || peakContacts !== null) return;
    fetch("/api/peak/contacts", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) setPeakContacts(d.contacts ?? []);
        else { setPeakContacts([]); setContactsError(d.error || "Could not load the PEAK contact list."); }
      })
      .catch(() => { setPeakContacts([]); setContactsError("Could not reach the server to load PEAK contacts."); });
  }, [contactEdit, peakContacts]);

  if (!sheet) return <div className="wrap"><section className="panel"><div className="op-empty">{msg || "…"}</div></section></div>;

  const t = computeTotals(sheet.expenses, sheet.guideFee);
  // Cost view: tour operating rows, plus a review reward only when it belongs to
  // THIS job (lib/jobsheet) — a carried-over reward is payment, not job cost.
  const cost = jobCostBreakdown(sheet.expenses, sheet.guideFee, sheet.ref, sheet.bookings);
  // Every figure the Summary shows, derived once (lib/peak-sync). Net Pay excludes
  // Company Direct rows — the company already paid those vendors directly, so
  // reimbursing them would pay for the same thing twice.
  const money = jobSheetTotals(sheet.expenses, sheet.guideFee, sheet.ref, sheet.bookings);
  // Which figures are not yet safe to pay from, and why. Marked AT the number as
  // well as listed, so nobody reads a total without seeing that it is provisional.
  const recheck = figuresNeedRecheck(sheet.expenses, money, {}, peak?.rows?.map((r) => r?.mappingStatus));
  const flagged = (f: "totalTourExpenses" | "reimbursementDue" | "netPayToGuide") => recheck.some((r) => r.field === f);
  const ro = !canEdit; // read-only (guide view)
  // Guides may tick no-shows only AFTER they've checked in AND within 30 min of the
  // tour start (that's when who turned up is known). Operators can mark any time.
  const startMs = Date.parse(`${sheet.date}T00:00:00Z`) + (((SLOT_TIMES[sheet.slotIdx] || "00:00").split(":").map(Number).reduce((h, m) => h * 60 + m, 0)) * 60_000) - 7 * 3600 * 1000;
  const inNoShowWindow = Date.now() >= startMs && Date.now() <= startMs + 30 * 60_000;
  const canMarkNoShow = canEdit || (checkedIn && inNoShowWindow);
  // Any edit marks the sheet dirty, so the PDF / Excel / e-slip buttons (which
  // auto-save only when !saved) always persist the change before exporting/uploading.
  const up = (patch: Partial<Sheet>) => { setSheet({ ...sheet, ...patch }); setSaved(false); if (msg) setMsg(""); };
  const setBooking = (i: number, p: Partial<Booking>) => up({ bookings: sheet.bookings.map((b, j) => j === i ? { ...b, ...p } : b) });
  // Guide (or operator) records how many of a booking's guests didn't arrive
  // (0 = all came, whole pax = fully absent, in between = partial). Persists to the
  // Booking so it shows in the operator's Tour Log; updates the row locally without
  // dirtying the sheet.
  const markNoShow = async (i: number, b: Booking, noShowPax: number) => {
    const P = b.bookedPax ?? 0;
    const ns = Math.max(0, Math.min(noShowPax, P || noShowPax));
    setSheet((s) => s ? { ...s, bookings: s.bookings.map((x, j) => j === i ? { ...x, noShowPax: ns, status: noShowStatus(ns, x.bookedPax), actualPax: Math.max(0, (x.bookedPax ?? 0) - ns) } : x) } : s);
    if (!b.bookingNo) return;
    // Record it first — the API also mirrors the count / status / actual pax onto the sheet.
    await fetch("/api/jobsheet/noshow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet!.guideId, date: sheet!.date, slotIdx: sheet!.slotIdx, bookingNo: b.bookingNo, noShowPax: ns }) }).catch(() => {});
    // …then upload a fresh copy to the Folkpaths Drive right away so the operator's
    // record reflects it immediately (best-effort; needs a saved sheet + Drive).
    if (drive.enabled && drive.connected) {
      try {
        const r = await fetch("/api/jobsheet/drive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet!.guideId, date: sheet!.date, slotIdx: sheet!.slotIdx }) });
        setMsg(r.ok ? (ns > 0 ? "No-show saved & uploaded to Drive ✓" : "Updated & uploaded to Drive ✓") : "No-show saved ✓");
      } catch { setMsg("No-show saved ✓"); }
    } else setMsg(ns > 0 ? "No-show saved ✓" : "Updated ✓");
  };
  const setExpense = (i: number, p: Partial<Expense>) => up({ expenses: sheet.expenses.map((e, j) => j === i ? { ...e, ...p } : e) });
  const sum = (key: "bookedPax" | "actualPax") => sheet.bookings.reduce((s, b) => s + (b[key] ?? 0), 0);
  // Total no-show pax reported across the sheet's bookings (per-booking count, with a
  // fallback for legacy rows that only carry the "no-show" status).
  const noShow = noShowStats(sheet.bookings);
  const noShowTotal = noShow.pax;

  // ---- Advance / settlement (cash movements; never part of the expense total) ----
  const advT = advanceTotals(advance.advances, advance.returns, sheet.expenses);
  const todayBKKstr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const tourCompleted = sheet.date < todayBKKstr || checkedIn;
  const advSt = advanceStatus(advT, tourCompleted);
  const hasAdvance = advance.advances.length > 0 || advance.returns.length > 0;
  const advChip = advSt === "SETTLED"
    ? <span className="badge active">✓ Settled</span>
    : advSt === "OVER_RETURNED"
      ? <span className="badge" style={{ background: "var(--danger-bg)", border: "1px solid var(--danger-line)", color: "var(--danger)" }}>⚠ Over-returned</span>
      : advSt === "PENDING_SETTLEMENT"
        ? <span className="badge pending">Pending {thb(advT.outstanding)}</span>
        : advSt === "OPEN"
          ? <span className="badge invited">Open · {thb(advT.outstanding)} out</span>
          : <span className="badge muted">No advance</span>;

  async function submitAdvance(kind: "advance" | "return") {
    if (!sheet) return;
    const amt = Number(advForm.amount.replace(/[,\s]/g, ""));
    if (!Number.isFinite(amt) || amt <= 0) { setMsg("Enter a positive amount in baht."); return; }
    if (kind === "return" && amt > Math.max(0, advT.outstanding) && !confirm(`Returned amount (${thb(amt)}) exceeds the remaining advance (${thb(Math.max(0, advT.outstanding))}).\n\nRecord it anyway? The job will show "Over-returned" for review.`)) return;
    if (canEdit && !saved) { const ok = await save(); if (!ok) return; } // the row keys off the persisted sheet
    setAdvBusy(true); setMsg("");
    const fd = new FormData();
    fd.append("kind", kind); fd.append("guideId", sheet.guideId); fd.append("date", sheet.date); fd.append("slotIdx", String(sheet.slotIdx));
    fd.append("amount", advForm.amount);
    if (advForm.at) fd.append("at", advForm.at);
    fd.append("method", advForm.method);
    if (advForm.txRef.trim()) fd.append("txRef", advForm.txRef.trim());
    if (advForm.note.trim()) fd.append("note", advForm.note.trim());
    if (advForm.file) {
      let blob: Blob = advForm.file;
      try { blob = await shrinkImage(advForm.file); } catch { /* keep original */ }
      fd.append("file", blob, shrunkName(advForm.file.name, blob));
    }
    const r = await fetch("/api/jobsheet/advance", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    setAdvBusy(false);
    if (!r.ok) {
      setMsg(d.error === "no-sheet" ? (canEdit ? "Save the sheet first." : "Ask the operator to save the job sheet first.")
        : d.error === "duplicate" ? "That amount was just recorded — refresh before recording it again."
        : d.error === "forbidden" ? "Not allowed."
        : d.error === "bad-amount" ? "Enter a positive amount in baht."
        : (d.error === "not-connected" || d.error === "not-configured") ? "Connect Google Drive first (slip upload)."
        : "Couldn't record it — try again.");
      return;
    }
    setAdvance({ advances: d.advances, returns: d.returns });
    setAdvKind(null); setAdvForm({ amount: "", at: "", method: "bank", txRef: "", note: "", file: null });
    setMsg(kind === "advance" ? "Advance recorded ✓" : "Return recorded ✓");
  }
  async function removeAdvanceRow(kind: "advance" | "return", row: AdvanceRow) {
    if (!sheet) return;
    if (!confirm(`Remove this ${kind === "advance" ? "advance" : "return"} of ${thb(row.amount)}? The full record is kept in the audit log; any slip stays in Drive.`)) return;
    setAdvBusy(true);
    const r = await fetch("/api/jobsheet/advance", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id: row.id, guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx }) });
    const d = await r.json().catch(() => ({}));
    setAdvBusy(false);
    if (!r.ok) { setMsg("Couldn't remove it."); return; }
    setAdvance({ advances: d.advances, returns: d.returns });
    setMsg("Removed — kept in the audit log.");
  }

  // ---- Guide's own expense report (separate from the operator's official set) ----
  const setGExp = (i: number, p: Partial<Expense>) => setGuideExp((arr) => arr.map((e, j) => j === i ? { ...e, ...p } : e));
  const addGExp = () => setGuideExp((arr) => [...arr, { description: "", price: null, pax: null }]);
  const rmGExp = (i: number) => setGuideExp((arr) => arr.filter((_, j) => j !== i));
  const guideExpTotal = guideExp.reduce((s, e) => s + expenseAmount(e), 0);
  async function submitGuideExpenses() {
    if (!sheet) return;
    setExpBusy(true); setMsg("");
    const clean = guideExp.filter((e) => (e.description || "").trim() || expenseAmount(e) > 0);
    const r = await fetch("/api/jobsheet/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, expenses: clean, note: guideNote.trim() }) });
    setExpBusy(false);
    if (r.ok) { setMsg("Expenses sent to the operator ✓"); load(); } else setMsg("Couldn't submit expenses — try again.");
  }
  // Operator: merge the guide's reported figures into the official expenses (then Save).
  // Make the official expenses EXACTLY the guide's reported figures — the guide ran the
  // tour, so their report is the actual spend. The Total updates to the guide's number
  // (an unreported template line like the lotus drops off). A line the guide left out
  // that still has a real amount is called out in the confirm so it isn't lost by
  // accident — the operator can cancel and add it back.
  async function acceptGuideExpenses() {
    if (!sheet?.guideExpenses) return;
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const gd = sheet.guideExpenses;
    const adopted = gd.map((e) => ({ ...e }));
    const gdKeys = new Set(gd.map((e) => norm(e.description)));
    const droppedReal = (sheet.expenses ?? []).filter((e) => !gdKeys.has(norm(e.description)) && expenseAmount(e) > 0);
    const gdTot = gd.reduce((s, e) => s + expenseAmount(e), 0);
    const warn = droppedReal.length
      ? `\n\nThe guide didn't report these — they'll be removed:\n${droppedReal.map((e) => `· ${e.description}  ${thb(expenseAmount(e))}`).join("\n")}`
      : "";
    if (!confirm(`Set the official expenses to the guide's reported figures (${thb(gdTot)})?${warn}`)) return;
    up({ expenses: adopted });                 // Total updates to the guide's number right away
    const ok = await save({ expenses: adopted }); // …and persist it in the same click
    if (ok) setMsg(`Official expenses set to the guide's report (${thb(gdTot)}) ✓`);
  }
  // Cross-check rows: merge official + guide-reported by description.
  const crossRows = (() => {
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const op = sheet?.expenses ?? [], gd = sheet?.guideExpenses ?? [];
    const keys = [...new Set([...op.map((e) => norm(e.description)), ...gd.map((e) => norm(e.description))])];
    return keys.map((k) => {
      const o = op.find((e) => norm(e.description) === k), g = gd.find((e) => norm(e.description) === k);
      const oa = o ? expenseAmount(o) : null, ga = g ? expenseAmount(g) : null;
      const desc = (o?.description || g?.description || "").trim();
      let flag: "match" | "differ" | "added" | "opOnly" = "match";
      if (oa == null) flag = "added"; else if (ga == null) flag = "opOnly"; else if (Math.round(oa) !== Math.round(ga)) flag = "differ";
      return { desc, key: k, g, oa, ga, flag };
    });
  })();

  const norm2 = (x: string) => (x || "").trim().toLowerCase();
  function adoptGuideLine(row: { key: string; g?: Expense; flag: string }) {
    if (!sheet || !row.g) return;
    if (row.flag === "added") {
      up({ expenses: [...sheet.expenses, { ...row.g }] });
    } else {
      // Copy the guide's figures VERBATIM — a blank/zero from the guide is the whole
      // point of adopting (e.g. "we never bought those tickets"). Falling back to the
      // operator's old numbers here made Use a silent no-op on blank guide rows.
      up({ expenses: sheet.expenses.map((e) => (norm2(e.description) === row.key ? { ...e, price: row.g!.price ?? null, pax: row.g!.pax ?? null, ...(row.g!.unit ? { unit: row.g!.unit } : {}) } : e)) });
    }
    setMsg(`Adopted “${(row.g!.description || row.key).trim()}” from the guide’s report — adjust if needed, then Save.`);
  }

  // `override` lets a caller save fields it just computed WITHOUT waiting for the
  // async setState to land (e.g. accept-guide-expenses saves the merged list right
  // away). Falls back to current sheet state when omitted.
  async function save(override?: Partial<Sheet>): Promise<boolean> {
    setBusy(true); setMsg("");
    const s = { ...sheet!, ...override };
    const r = await fetch("/api/jobsheet", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: s.guideId, date: s.date, slotIdx: s.slotIdx, tourId: s.tourId, status: s.status, bookings: s.bookings, expenses: s.expenses, guideFee: s.guideFee, operatorNote: s.operatorNote ?? "" }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "bad-body" ? (d.detail ? `Check: ${d.detail}` : "Please check the values.") : d.error === "forbidden" ? "Operator only." : "Save failed."); return false; }
    setSheet(d.sheet); setSaved(true); setMsg("Saved ✓"); return true;
  }
  async function sendToGuide() {
    // Auto-save first so you never hit a "save first" dead-end.
    if (!saved) { const ok = await save(); if (!ok) return; }
    setBusy(true); setMsg("Sending…");
    const r = await fetch("/api/jobsheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: sheet!.date, guideId: sheet!.guideId }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg("Send failed."); return; }
    if ((d.count ?? 0) === 0) { setMsg("Nothing to send — assign a guide to this slot first."); return; }
    setMsg(d.lineSent > 0 ? `✅ Sent to guide on LINE` : `✅ Sent to guide's in-app inbox (link LINE to also send there)`);
  }

  // Operator: sign off (or un-sign) the actual expenses before payout / PEAK sync.
  // Auto-saves first so approval always ties to the persisted figures. Records
  // approvedBy/approvedAt server-side; the pill in the toolbar reflects the state.
  async function toggleApprove() {
    if (!sheet) return;
    if (!saved) { const ok = await save(); if (!ok) return; }
    const approve = !isApproved(sheet.approvalStatus);
    setBusy(true); setMsg(approve ? "Approving…" : "Removing approval…");
    const r = await fetch("/api/jobsheet/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, approve }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "no-sheet" ? "Save the sheet first." : d.error === "forbidden" ? "Operator only." : "Couldn't update approval."); return; }
    setSheet((s) => s ? { ...s, approvalStatus: d.approvalStatus, approvedBy: d.approvedBy, approvedAt: d.approvedAt } : s);
    setMsg(isApproved(d.approvalStatus) ? "Approved ✓" : "Approval removed");
  }

  // Operator: record (or clear) the guide's PEAK Contact id. This is the mapping
  // whose absence blocks every sync, so it is editable right where that block is
  // reported rather than on a separate admin screen. Writes to the guide's profile,
  // not to this sheet — one guide, one contact, reused by every job.
  async function savePeakContact(value: string) {
    if (!sheet) return;
    setBusy(true); setMsg(value.trim() ? "Mapping guide to PEAK…" : "Clearing mapping…");
    const r = await fetch("/api/jobsheet/peak-contact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guideId: sheet.guideId,
        peakContactId: value.trim(),
        // Snapshot the name from the list so the sheet can say WHO it is mapped to
        // rather than showing an opaque id.
        peakContactName: peakContacts?.find((c) => c.id === value.trim())?.name,
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "no-guide" ? "Guide not found." : d.error === "forbidden" ? "Operator only." : "Couldn't save the mapping."); return; }
    setContactEdit(null);
    setMsg(d.peakContactId ? "Guide mapped to PEAK contact ✓" : "PEAK contact mapping cleared");
    load(); // re-evaluates sync eligibility server-side
  }

  // Operator: attach / detach a supporting receipt on ONE expense line. Auto-saves
  // first so the row index the server writes to is stable. Images are shrunk client-
  // side (same as e-slips) before upload. The server returns the updated sheet.
  async function uploadReceipt(i: number, file: File) {
    if (!sheet) return;
    if (!saved) { const ok = await save(); if (!ok) return; }
    setBusy(true); setMsg("Uploading receipt…");
    let blob: Blob = file;
    try { blob = await shrinkImage(file); } catch { /* fall back to the original file */ }
    const fd = new FormData();
    fd.append("guideId", sheet.guideId); fd.append("date", sheet.date); fd.append("slotIdx", String(sheet.slotIdx)); fd.append("expenseIndex", String(i));
    fd.append("file", blob, shrunkName(file.name, blob));
    const r = await fetch("/api/jobsheet/receipt", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "too-large" ? "Receipt too large (max 10 MB)." : d.error === "bad-type" ? "Upload an image or a PDF." : (d.error === "not-connected" || d.error === "not-configured") ? "Connect Google Drive first." : d.error === "no-sheet" ? "Save the sheet first." : "Couldn't attach the receipt."); return; }
    setSheet(d.sheet); setSaved(true); setMsg("Receipt attached ✓");
  }
  async function removeReceipt(i: number) {
    if (!sheet) return;
    if (!confirm("Remove this receipt from the expense line? The file stays in Drive.")) return;
    setBusy(true); setMsg("Removing receipt…");
    const r = await fetch("/api/jobsheet/receipt", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, expenseIndex: i }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg("Couldn't remove the receipt."); return; }
    setSheet(d.sheet); setSaved(true); setMsg("Receipt removed");
  }

  // Operator: return the job to the operator — unassign this guide and send its bookings
  // back to the Bookings inbox to re-dispatch. Notifies the guide. Blocked once the guide
  // has checked in (before-start only). Reuses DELETE /api/assignments (release: true).
  async function returnToOperator() {
    if (!sheet) return;
    const when = `${sheet.date} · ${SLOT_TIMES[sheet.slotIdx] ?? ""}`;
    const who = header?.name || sheet.guideId;
    if (!confirm(`Return this tour to the operator?\n${who} · ${when} · ${tour?.name ?? sheet.tourId}\n\n${sheet.guideId} is unassigned and the tour's bookings go back to the inbox to re-dispatch. The guide is notified.`)) return;
    setBusy(true); setMsg("Returning to operator…");
    const r = await fetch("/api/assignments", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, release: true }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "tour-in-progress" ? "Can't return — the guide already checked into this tour. Undo it from the Tour Log instead." : "Failed to return the job."); return; }
    router.back();
  }
  // Operator: delete the whole tour record for this slot (sheet + assignment + payment +
  // check-ins + report + rating + manual bookings). For a cancelled tour or a bad import;
  // real (Bokun) bookings are kept. Blocked once the guide has checked in. Reuses
  // DELETE /api/jobsheet with guardStarted so a started tour can't be wiped here.
  async function deleteJobSheet() {
    if (!sheet) return;
    const when = `${sheet.date} · ${SLOT_TIMES[sheet.slotIdx] ?? ""}`;
    const who = header?.name || sheet.guideId;
    if (!confirm(`Delete this job sheet?\n${who} · ${when} · ${tour?.name ?? sheet.tourId}\n\nDeletes the job sheet, the guide's assignment, payment, check-in, report and rating — AND removes this slot's bookings (including OTA/Bokun ones) so they don't re-appear as a job. Cancel them on the OTA first. Cannot be undone.`)) return;
    setBusy(true); setMsg("Deleting…");
    const r = await fetch("/api/jobsheet", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, guardStarted: true }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "tour-in-progress" ? "This tour has already started — delete it from Payments / Tour Log instead." : d.error === "forbidden" ? "Operator only." : "Delete failed."); return; }
    router.back();
  }

  const L = { width: "100%", boxSizing: "border-box" as const, padding: "5px 7px", border: "1px solid var(--line,#d9d9d9)", borderRadius: 6, font: "inherit" };

  return (
    <div className="wrap jobsheet">
      <div className="js-bar no-print">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn ghost" onClick={() => router.back()}>← Back</button>
          {canEdit && <button className="btn" disabled={busy || checkedIn} title={checkedIn ? "The guide has checked in — return or undo it from the Tour Log instead" : "Unassign this guide and send the job back to the inbox to re-dispatch (notifies the guide)"} onClick={returnToOperator}>↩ Return to operator</button>}
          {canEdit && <button className="btn danger" disabled={busy || checkedIn} title={checkedIn ? "The guide has checked in — delete it from Payments / Tour Log instead" : "Delete this job sheet and its tour records"} onClick={deleteJobSheet}>Delete job sheet</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {ro && <span style={{ color: "var(--ink-soft,#888)", fontWeight: 600, fontSize: 13 }}>View only</span>}
          <span style={{ color: saved ? "var(--green,#1a7f37)" : "var(--ink-soft,#888)", fontWeight: 600, fontSize: 13 }}>{msg}</span>
          {ro && <button className="btn primary" onClick={() => window.open(`/api/jobsheet/joborder?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener")} title="Open your official guide job order (ใบสั่งงานมัคคุเทศก์)">Job order</button>}
          {ro && <button className="btn" onClick={() => window.open(`/api/jobsheet/pdf?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener")} title="Open the full job sheet as a PDF for reference">📄 PDF</button>}
          <a className="btn" target="_blank" rel="noopener noreferrer"
            href={gcalUrl(tour?.name ?? "Tour", sheet.date, sheet.slotIdx, tour?.durationMin || 180, `Guide: ${header?.name ?? ""}\nFolkpath job · open the app for full details`)}>Add to Google Calendar</a>
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.open(`/api/jobsheet/pdf?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener"); }}>PDF</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.open(`/api/jobsheet/joborder?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener"); }}>Job order</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.location.href = `/api/jobsheet/export?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`; }}>Excel</button>}
          {canEdit && drive.enabled && !drive.connected && <a className="btn" href="/api/google/connect" title="Connect a Google account so the PDF can be saved to Drive">☁ Connect Google Drive</a>}
          {canEdit && isApproved(sheet.approvalStatus) && (
            <span title={sheet.approvedAt ? `Approved ${new Date(sheet.approvedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Approved for payout"} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 700, color: "var(--green,#2f7d4f)", background: "var(--ok-bg,#eef7f0)", border: "1px solid var(--ok-line,#cfe6d6)", borderRadius: 999, padding: "3px 10px" }}>✓ Approved</span>
          )}
          {canEdit && <button className="btn" disabled={busy} onClick={toggleApprove} title="Operator sign-off on the actual expenses before payout / PEAK sync">{isApproved(sheet.approvalStatus) ? "Unapprove" : "Approve"}</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={sendToGuide}>Send to guide</button>}
          {canEdit && <button className="btn primary" disabled={busy} onClick={() => save()}>{busy ? "…" : "Save"}</button>}
        </div>
      </div>

      {sheet.status === "Review: no-show" && (
        <div className="no-print" style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-line)", color: "var(--danger)", fontWeight: 600, fontSize: 13.5 }}>
          ⚠ A guide reported a no-show on this tour. Absent guests were removed from the pax counts and ticket expenses — confirm the numbers before payout.
        </div>
      )}

      {ro && (() => {
        const totalPax = sheet.bookings.reduce((s, b) => s + (b.actualPax ?? b.bookedPax ?? 0), 0);
        const exp = sheet.expenses.filter((e) => expenseAmount(e) > 0);
        const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
        const paid = !!payment?.paid;
        // Once paid (slip uploaded), the report flow closes and the summary shows the
        // operator's FINAL official expenses (t.totalExpenses) — which equal the transfer.
        const canReport = (checkedIn || sheet.date <= today) && !paid; // tour done & not yet paid → guide reports
        const expShown = canReport ? guideExpTotal : t.totalExpenses;
        const grandShown = t.netGuideFee + expShown;
        return (
          <section className="panel guide-sum">
            <div className="gs-head">
              <h2>{tour?.name ?? "Your tour"}</h2>
              <div className="gs-when">{sheet.date} · {SLOT_TIMES[sheet.slotIdx] ?? ""}{totalPax ? ` · ${totalPax} pax` : ""}</div>
            </div>
            <div className="gs-grid">
              <div>
                <h3>Your customers ({sheet.bookings.length}){noShowTotal > 0 ? <span style={{ color: "var(--danger)", fontWeight: 700 }}> · {noShowTotal} no-show</span> : null}</h3>
                {ro && !canMarkNoShow && <div style={{ fontSize: 11.5, color: "var(--ink-soft)", margin: "2px 0 6px" }}>{!checkedIn ? "Check in to report no-shows." : "No-show reporting is open for 30 minutes after the tour starts."}</div>}
                {sheet.bookings.length ? (
                  <ol className="gs-cust">
                    {sheet.bookings.map((b, i) => {
                      const P = b.bookedPax ?? 0;
                      const ns = b.noShowPax ?? (b.status === "no-show" ? P : 0); // absent pax on this booking
                      const full = P > 0 && ns >= P, partial = ns > 0 && ns < P;
                      return (
                      <li key={i} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <span style={{ flex: 1, minWidth: 130, textDecoration: full ? "line-through" : "none", color: full ? "var(--danger)" : "inherit" }}><b>{b.name || "—"}</b>{b.bookingNo ? <span className="gs-ref"> · {b.bookingNo}</span> : ""}{(b.actualPax ?? b.bookedPax) != null ? <span className="gs-ref"> · {partial ? `${P - ns} of ${P}` : (b.actualPax ?? b.bookedPax)} pax</span> : ""}</span>
                        {b.tickets && <span style={{ fontSize: 11, fontWeight: 700, color: b.tickets === "included" ? "#2e7d4f" : "var(--ink-soft)", whiteSpace: "nowrap" }} title="Set by the operator">{b.tickets === "included" ? "Tickets incl." : "No tickets"}</span>}
                        {canMarkNoShow ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: ns > 0 ? "var(--danger)" : "var(--ink-soft)", cursor: b.bookingNo ? "pointer" : "default" }} title={b.bookingNo ? "Mark this booking as a no-show" : "No reference to mark"}>
                              <input type="checkbox" checked={ns > 0} disabled={!b.bookingNo} onChange={(e) => markNoShow(i, b, e.target.checked ? P : 0)} style={{ width: 17, height: 17, accentColor: "var(--danger)" }} />
                              No-show
                            </label>
                            {P > 1 && b.bookingNo && (
                              <span style={{ fontSize: 11.5, color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 4 }} title="How many of this booking actually came">
                                came
                                <input type="number" min={0} max={P} value={P - ns} onChange={(e) => markNoShow(i, b, P - Math.max(0, Math.min(P, Number(e.target.value) || 0)))} style={{ width: 44, padding: "3px 5px", border: "1px solid var(--line-strong)", borderRadius: 6, font: "inherit", fontSize: 11.5, textAlign: "right" }} />
                                / {P}
                              </span>
                            )}
                          </span>
                        ) : (full ? <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--danger)", whiteSpace: "nowrap" }}>✗ No-show</span> : partial ? <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--danger)", whiteSpace: "nowrap" }}>✗ {ns} of {P} no-show</span> : null)}
                      </li>
                      );
                    })}
                  </ol>
                ) : <div className="gs-empty">No customer list yet.</div>}
              </div>
              <div>
                <h3>Payout</h3>
                {!canReport && (exp.length ? (
                  <ul className="gs-exp">
                    {exp.map((e, i) => (
                      <li key={i}>
                        <span>{e.description}<br /><small className="gs-calc">{thb(e.price ?? 0)} × {e.pax ?? 0} pax (incl. guide)</small></span>
                        <b>{thb(expenseAmount(e))}</b>
                      </li>
                    ))}
                    <li className="gs-total"><span>Total expenses</span><b>{thb(t.totalExpenses)}</b></li>
                  </ul>
                ) : <div className="gs-empty">No expenses recorded.</div>)}
                <div className="gs-payout">
                  <div className="gs-payout-row"><span>Expenses{canReport ? " (your report)" : " (reimbursed)"}</span><b>{thb(expShown)}</b></div>
                  <div className="gs-payout-row"><span>Guide fee · after {sheet.guideFee.whtPct ?? 3}% WHT</span><b>{thb(t.netGuideFee)}</b></div>
                  <div className="gs-payout-row gs-grand"><span>You&apos;ll receive</span><b>{thb(grandShown)}</b></div>
                </div>
                {hasAdvance && (
                  <div style={{ marginTop: 8, padding: "8px 10px", background: advSt === "SETTLED" ? "var(--ok-bg,#eef7f0)" : advSt === "OVER_RETURNED" ? "var(--danger-bg)" : "var(--grey-bg,#f7f7f7)", border: `1px solid ${advSt === "SETTLED" ? "var(--ok-line,#cfe6d6)" : advSt === "OVER_RETURNED" ? "var(--danger-line)" : "var(--line)"}`, borderRadius: 8, fontSize: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontWeight: 700 }}>
                      <span>Advance from Folkpaths</span>
                      <span>{advSt === "SETTLED" ? "✓ Settled" : advSt === "OVER_RETURNED" ? "⚠ Review" : advT.outstanding > 0 ? `Return ${thb(advT.outstanding)}` : ""}</span>
                    </div>
                    <div style={{ color: "var(--ink-soft)", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
                      Received {thb(advT.totalAdvancePaid)} · Spent {thb(advT.usedFromAdvance)} · Returned {thb(advT.totalReturned)} · Balance {thb(advT.outstanding)}
                    </div>
                    {advT.outstanding > 0 && tourCompleted && <div style={{ color: "var(--ink)", marginTop: 4 }}>Transfer the unused {thb(advT.outstanding)} back to Folkpaths, then record it in the full sheet (“See full details” → Record return).</div>}
                  </div>
                )}
                {paid && (
                  <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--ok-bg, #eef7f0)", border: "1px solid var(--ok-line, #cfe6d6)", borderRadius: 8, fontSize: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontWeight: 700, color: "var(--green, #2f7d4f)" }}>
                      <span>✓ Paid{payment?.paidAt ? ` · ${new Date(payment.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}</span>
                      {payment?.slip && <a href={payment.slip} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green, #2f7d4f)", fontWeight: 700 }}>View slip</a>}
                    </div>
                    <div style={{ color: "var(--ink-soft)", marginTop: 3 }}>These are the operator&apos;s final figures — they match your transfer.</div>
                  </div>
                )}
                {canReport && <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 6 }}>Based on the expenses you report below · confirmed by the operator.</div>}
              </div>
            </div>
            {canReport && (
              <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <h3 style={{ margin: "0 0 2px" }}>Report your expenses</h3>
                <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>Enter what you actually paid on tour, then submit — the operator cross-checks it against the sheet.</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink-soft)" }}>
                    <th style={{ textAlign: "left", padding: "2px 4px" }}>Description</th><th style={{ width: 72, padding: "2px 4px" }}>Price</th><th style={{ width: 56, padding: "2px 4px" }}>Pax</th><th style={{ width: 84, textAlign: "right", padding: "2px 4px" }}>Amount</th><th style={{ width: 24 }}></th>
                  </tr></thead>
                  <tbody>
                    {guideExp.map((e, i) => (
                      <tr key={i}>
                        <td style={{ padding: "3px 4px" }}><input style={L} value={e.description} placeholder="e.g. Grand Palace ticket" onChange={(ev) => setGExp(i, { description: ev.target.value })} /></td>
                        <td style={{ padding: "3px 4px" }}><input style={{ ...L, textAlign: "right" }} type="number" value={e.price ?? ""} onChange={(ev) => setGExp(i, { price: numOrNull(ev.target.value) })} /></td>
                        <td style={{ padding: "3px 4px" }}><input style={{ ...L, textAlign: "right" }} type="number" value={e.pax ?? ""} onChange={(ev) => setGExp(i, { pax: numOrNull(ev.target.value) })} /></td>
                        <td style={{ padding: "3px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(expenseAmount(e))}</td>
                        <td style={{ textAlign: "center" }}><button onClick={() => rmGExp(i)} title="Remove" style={{ border: "none", background: "none", color: "var(--ink-soft)", cursor: "pointer", fontSize: 14 }}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr style={{ borderTop: "1.5px solid var(--line)" }}><td colSpan={3} style={{ textAlign: "right", padding: "6px 4px", fontWeight: 700 }}>Total expenses</td><td style={{ textAlign: "right", padding: "6px 4px", fontWeight: 800, color: "var(--primary)" }}>{thb(guideExpTotal)}</td><td></td></tr></tfoot>
                </table>
                <div style={{ marginTop: 10 }}>
                  <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Note (optional)</label>
                  <textarea value={guideNote} maxLength={500} onChange={(e) => setGuideNote(e.target.value)} placeholder="e.g. bought extra water — very hot day" rows={2} style={{ width: "100%", boxSizing: "border-box", marginTop: 3, padding: "6px 8px", border: "1px solid var(--line,#d9d9d9)", borderRadius: 6, font: "inherit", fontSize: 13, resize: "vertical" }} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                  <button className="btn sm" onClick={addGExp}>+ Add expense</button>
                  <button className="btn primary" disabled={expBusy} onClick={submitGuideExpenses} style={{ marginLeft: "auto" }}>{expBusy ? "Sending…" : "Submit expenses to operator"}</button>
                </div>
                {sheet.guideExpensesAt && <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 8 }}>✓ Last sent {new Date(sheet.guideExpensesAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</div>}
              </div>
            )}
            <div style={{ marginTop: 14, textAlign: "center" }}>
              <button className="btn" onClick={() => setShowFull((s) => !s)}>{showFull ? "Hide full details" : "📄 See full details"}</button>
            </div>
          </section>
        );
      })()}

      {/* Floating save — the toolbar Save scrolls out of view on a long sheet, which
          read as "there is no Save button" mid-edit. Appears only when dirty. */}
      {canEdit && !saved && (
        <div className="no-print" style={{ position: "fixed", right: 18, bottom: 18, zIndex: 60, display: "flex", gap: 10, alignItems: "center", background: "var(--card,#fff)", border: "1px solid var(--line,#ddd)", borderRadius: 999, boxShadow: "0 6px 20px rgba(0,0,0,.14)", padding: "8px 10px 8px 16px" }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-soft,#777)", fontWeight: 600 }}>Unsaved changes<span style={{ display: "block", fontSize: 10.5, fontWeight: 500 }}>มีการแก้ไข ยังไม่บันทึก</span></span>
          <button className="btn primary" disabled={busy} onClick={() => save()}>{busy ? "…" : "Save · บันทึก"}</button>
        </div>
      )}

      {(canEdit || showFull) && (
      <div className="js-detail-grid">
      <section className="panel js-sheet" style={{ padding: 18 }}>
       {/* Section tabs — "All" is the classic single-scroll sheet (default, so the
           existing workflow is unchanged); the others focus one part of the job. */}
       <div className="subtabs no-print" style={{ marginBottom: 14 }}>
         {([["all", "All"], ["details", "Job details"], ["expenses", "Expenses"], ["fee", "Fee & summary"]] as const).map(([k, l]) => (
           <button key={k} type="button" className={`subtab${secTab === k ? " active" : ""}`} onClick={() => setSecTab(k)}>{l}</button>
         ))}
       </div>
       {/* Financial summary — live from the same computeTotals the payout uses. */}
       <div className="kpi-row no-print" style={{ marginBottom: 14 }}>
         {/* Must match the Summary at the bottom of this same page. These read
             computeTotals() directly and showed the pre-correction payout, so the
             top of the sheet said 2,815 while the bottom said 1,815 — and
             "Reimbursement" was total expenses, not what the guide is owed back. */}
         <div className="kpi"><b style={{ fontSize: 19 }}>{thb(money.netGuideFee)}</b><span>Guide fee · net of {sheet.guideFee.whtPct ?? 3}% WHT</span></div>
         <div className="kpi"><b style={{ fontSize: 19 }}>{thb(money.reimbursementDue)}</b><span>Reimbursement due</span></div>
         <div className="kpi" style={{ borderColor: "var(--primary)" }}><b style={{ fontSize: 19, color: "var(--primary)" }}>{thb(money.netPayToGuide)}</b><span>Net pay to guide</span></div>
       </div>
       <fieldset disabled={ro} style={{ border: 0, margin: 0, padding: 0, minInlineSize: "auto" }}>
        {/* Header */}
        <div className="js-head">
          {/* Company/legal reference — deliberately small and secondary (§header
              hierarchy): the eye must land on JOB SHEET + the job no., not on the
              Tax ID. Exact official spellings — legal entity and licensed tour
              operator are intentionally spelled differently. */}
          <div className="js-brand" style={{ breakInside: "avoid" }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.06em" }}>{CO.brandName}</div>
            <div style={{ fontSize: 9, color: "var(--ink-soft,#888)" }}>Operated by {CO.operatedBy} / {CO.legalNameTh}</div>
            <div style={{ fontSize: 8.5, color: "var(--ink-soft,#999)" }}>Tax ID {CO.taxId} · Tour Operator {CO.tourOperatorNameTh} · License {CO.tourismLicenseNo}</div>
          </div>
          <table className="js-meta"><tbody>
            <tr><td style={{ whiteSpace: "nowrap" }}>Job No. <small style={{ fontSize: 8.5, color: "var(--ink-soft)", marginLeft: 3 }}>เลขที่งาน</small></td><td>{sheet.ref ?? <span style={{ color: "#aaa" }}>—</span>}</td></tr>
            <tr><td style={{ whiteSpace: "nowrap" }}>Updated <small style={{ fontSize: 8.5, color: "var(--ink-soft)", marginLeft: 3 }}>ปรับปรุงล่าสุด</small></td><td>{sheet.updatedAt ? new Date(sheet.updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : <i style={{ color: "#aaa" }}>not saved yet</i>}</td></tr>
            <tr><td style={{ whiteSpace: "nowrap" }}>Tour ID <small style={{ fontSize: 8.5, color: "var(--ink-soft)", marginLeft: 3 }}>รหัสทัวร์</small></td><td><b>{sheet.tourId || "—"}</b></td></tr>
            <tr><td style={{ whiteSpace: "nowrap" }}>Guide ID <small style={{ fontSize: 8.5, color: "var(--ink-soft)", marginLeft: 3 }}>รหัสมัคคุเทศก์</small></td><td>{sheet.guideId}</td></tr>
            <tr><td style={{ whiteSpace: "nowrap" }}>Status <small style={{ fontSize: 8.5, color: "var(--ink-soft)", marginLeft: 3 }}>สถานะงาน</small></td><td>
              <select value={sheet.status} onChange={(e) => up({ status: e.target.value })} className="no-print-border">
                {/* include the live status (e.g. "Review: no-show", set by a guide's report) so it
                    renders instead of a blank box and is never lost when the operator saves */}
                {Array.from(new Set(["Confirmed", "Pending", "Cancelled", sheet.status])).map((s) => <option key={s}>{s}</option>)}
              </select>
              <span className="print-only">{sheet.status}</span>
            </td></tr>
          </tbody></table>
        </div>

        {/* Job header — the facts an operator needs before reading any money.
            Every field below is existing data: the sheet, the guide's profile, the
            tour record, or this job's bookings (jobMeta, assembled server-side).
            The guide's PII rows stay — the printed sheet is an accounting document. */}
        <div className="js-guide">
          <div><span>Tour Date <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>วันที่นำเที่ยว</small></span><b>{date}</b></div>
          <div><span>Time <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>เวลาเริ่มทัวร์</small></span><b style={{ color: "var(--primary)" }}>{SLOT_TIMES[sheet.slotIdx] ?? tour?.time ?? ""}</b></div>
          <div><span>Tour Name <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>ชื่อรายการนำเที่ยว</small></span><b style={{ color: "var(--primary)" }}>{tour?.name || ""}</b></div>
          <div><span>Pax <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>จำนวนผู้เดินทาง</small></span><b>{sum("actualPax") || sum("bookedPax") || "—"}</b></div>
          {/* .js-guide is a 4-column grid whose rows use display:contents, so every
              CHILD of this div is a grid item — a label and exactly one value. An
              extra element here (e.g. a separate span for the channel) adds a third
              item and shifts every following label/value pair by one cell, which
              desyncs the whole header. Keep the value a single node. */}
          <div><span>Guide Name <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>ชื่อมัคคุเทศก์</small></span>{header?.name || ""}</div>
          <div><span>Guide License ID <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>เลขที่ใบอนุญาตมัคคุเทศก์</small></span>{header?.licenseNo || "—"}</div>
          <div><span>Tax ID <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>เลขประจำตัวผู้เสียภาษี</small></span>{header?.taxId || "—"}</div>
          <div><span>Address <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>ที่อยู่</small></span>{header?.address || "—"}</div>
          <div><span>E-mail <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>อีเมล</small></span>{header?.email || ""}</div>
          <div><span>Tel. <small style={{ fontSize: 8.5, color: "var(--ink-soft)" }}>โทรศัพท์</small></span>{header?.tel || "—"}</div>
        </div>

        {/* Job details */}
        <div style={{ display: secTab === "all" || secTab === "details" ? undefined : "none" }}>
        <h3 className="js-section">Job Details<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"รายละเอียดงาน"}</small></h3>
        <table className="js-table">
          <thead><tr><th><TH en="No." th="ลำดับ" /></th><th><TH en="Guest Name" th="ชื่อผู้เดินทาง" /></th><th><TH en="Booking No." th="เลขที่การจอง" /></th><th><TH en="Booked Pax" th="จำนวนที่จอง" /></th><th><TH en="Actual Pax" th="จำนวนผู้เดินทางจริง" /></th><th><TH en="Tickets" th="บัตรเข้าชม" /></th><th className="no-print" /></tr></thead>
          <tbody>
            {sheet.bookings.map((b, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input style={L} value={b.name} onChange={(e) => setBooking(i, { name: e.target.value })} /></td>
                <td><input style={L} value={b.bookingNo} onChange={(e) => setBooking(i, { bookingNo: e.target.value })} /></td>
                <td><input style={{ ...L, width: 70 }} type="number" value={b.bookedPax ?? ""} onChange={(e) => setBooking(i, { bookedPax: numOrNull(e.target.value) })} /></td>
                <td><input style={{ ...L, width: 70 }} type="number" value={b.actualPax ?? ""} onChange={(e) => setBooking(i, { actualPax: numOrNull(e.target.value) })} /></td>
                <td>
                  <select style={{ ...L, appearance: "none", WebkitAppearance: "none", MozAppearance: "none", backgroundImage: "none", cursor: "pointer" }} value={b.tickets} onChange={(e) => setBooking(i, { tickets: e.target.value as Booking["tickets"] })}>
                    <option value="">—</option><option value="included">Included</option><option value="not">Not incl.</option>
                  </select>
                </td>
                <td className="no-print"><button className="btn sm danger" onClick={() => up({ bookings: sheet.bookings.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
            <tr className="js-total"><td /><td colSpan={2} style={{ textAlign: "right" }}>Total</td><td>{sum("bookedPax")}</td><td>{sum("actualPax")}</td><td /><td className="no-print" /></tr>
            {noShowTotal > 0 && <tr className="js-total"><td /><td colSpan={2} style={{ textAlign: "right", color: "var(--danger)" }}>No-show <small style={{ fontSize: 9, fontWeight: 500 }}>ไม่มาใช้บริการ</small></td><td colSpan={2} style={{ color: "var(--danger)", fontWeight: 700, whiteSpace: "nowrap" }}>{noShow.pax} pax · {noShow.bookings} booking{noShow.bookings === 1 ? "" : "s"}</td><td /><td className="no-print" /></tr>}
          </tbody>
        </table>
        <button className="btn sm no-print" onClick={() => up({ bookings: [...sheet.bookings, { name: "", bookingNo: "", bookedPax: null, actualPax: null, tickets: "", status: "" }] })}>+ Add booking</button>
        </div>

        {/* TOUR EXPENSES — company cost in this job. Accounting mapping keys off
            the CATEGORY (lib/jobsheet), never the description. */}
        <div style={{ display: secTab === "all" || secTab === "expenses" ? undefined : "none" }}>
        <h3 className="js-section" style={{ background: "#fff8c4" }}>TOUR EXPENSES<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"ค่าใช้จ่ายในการนำเที่ยว"}</small><span className="js-sub">Company cost in this job</span></h3>
        <table className="js-table js-exp-table">
          <thead><tr>
            <th style={{ width: 26 }}>#</th>
            <th style={{ width: 132 }}><TH en="Expense Category" th="ประเภทค่าใช้จ่าย" /></th>
            <th><TH en="Description" th="รายการ" /></th>
            <th className="no-print" style={{ width: 150 }} title="Source of money used to pay this line — Guide Advance rows settle against the advance below; Guide Personal rows create reimbursement due"><TH en="Paid By" th="แหล่งเงินที่ใช้ชำระ" /></th>
            <th className="no-print" style={{ width: 84 }}><TH en="Receipt" th="หลักฐาน" /></th>
            <th style={{ width: 152, textAlign: "right" }}><TH en="Amount (THB)" th="จำนวนเงิน" /></th>
            <th className="no-print" style={{ width: 92 }}><TH en="Account Status" th="สถานะบัญชี" /></th>
            <th className="no-print" style={{ width: 34 }}><TH en="Actions" th="จัดการ" /></th>
          </tr></thead>
          <tbody>
            {sheet.expenses.map((e, i) => ({ e, i })).filter(({ e }) => !isReviewExpense(e)).map(({ e, i }, n) => {
              // Server-computed status for this row when available (it knows which
              // PEAK accounts are configured); the local rule is the fallback.
              const pr = peak?.rows?.[i];
              const acct = pr?.mappingStatus ?? (expenseAccountingStatus(e) === "READY" ? "READY" : "NEEDS_REVIEW");
              const already = pr?.disposition === "ALREADY_RECORDED" || !!e.alreadyRecordedInPeak;
              const paid = canonicalPaidBy(e);
              return (
              <tr key={i}>
                <td style={{ color: "var(--ink-soft)" }}>{n + 1}</td>
                <td>
                  {ro ? expenseCategoryLabel(e) : (
                    <select style={{ ...L, appearance: "none", WebkitAppearance: "none", backgroundImage: "none", cursor: "pointer", ...(expenseCategory(e) ? {} : { color: "var(--ink-soft)" }) }}
                      value={expenseCategory(e) ?? ""} onChange={(ev) => setExpense(i, { expenseType: ev.target.value })}
                      title="The stable category this expense is booked under. Accounting maps on THIS, not on the description.">
                      <option value="">— choose —</option>
                      {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  )}
                </td>
                <td><input style={L} value={e.description} onChange={(ev) => setExpense(i, { description: ev.target.value })} /></td>
                <td className="no-print">
                  {/* Payment source maps to the existing paidBy field; legacy rows (unset /
                      "operator") read as Company. "Guide Advance" rows feed the settlement.
                      Deliberately NOT an input to the accounting category — who fronted the
                      cash says nothing about what the cost is. */}
                  {/* An untagged row now shows "— not set —" rather than defaulting the display to
                      Company Direct. Who paid decides whether the guide is reimbursed, so
                      guessing it silently either overpays or underpays a real person. */}
                  <select style={{ ...L, appearance: "none", WebkitAppearance: "none", backgroundImage: "none", cursor: "pointer", ...(paid === "GUIDE_ADVANCE" ? { borderColor: "var(--primary)", fontWeight: 600 } : paid === "GUIDE_PERSONAL" ? { borderColor: "#b45309", fontWeight: 600 } : paid === "UNSPECIFIED" ? { borderColor: "var(--assign)", color: "var(--assign)", fontWeight: 600 } : {}) }} value={paid === "GUIDE_ADVANCE" ? "advance" : paid === "GUIDE_PERSONAL" ? "guide" : paid === "COMPANY_DIRECT" ? "company" : ""} onChange={(ev) => setExpense(i, { paidBy: ev.target.value })} title={PAYMENT_SOURCES.map((x) => `${x.label} (${x.th}) — ${x.effect}`).join("\n")}>
                    {paid === "UNSPECIFIED" && <option value="">— not set —</option>}
                    {PAYMENT_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label} — {s.effect}</option>)}
                  </select>
                </td>
                <td className="no-print" style={{ whiteSpace: "nowrap", textAlign: "center" }}>
                  {e.receiptUrl ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <a href={e.receiptUrl} target="_blank" rel="noopener noreferrer" title={e.receiptName || "View receipt"} style={{ fontSize: 11.5, fontWeight: 700, color: "var(--green,#2f7d4f)", maxWidth: 78, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.receiptName || "View"}</a>
                      {canEdit && <button type="button" className="btn sm danger" title="Remove receipt" onClick={() => removeReceipt(i)}>×</button>}
                    </span>
                  ) : canEdit ? (
                    <label className="btn sm" style={{ cursor: "pointer", margin: 0 }} title="Attach a receipt (image or PDF, max 10 MB)">
                      Attach
                      <input type="file" accept="image/*,application/pdf" hidden onChange={(ev) => { const f = ev.target.files?.[0]; ev.currentTarget.value = ""; if (f) uploadReceipt(i, f); }} />
                    </label>
                  ) : <span style={{ color: "var(--ink-soft)" }}>—</span>}
                </td>
                <td className="js-amt">
                  {!ro && (
                    <span className="js-amt-in no-print">
                      <input style={{ ...L, width: 60, textAlign: "right" }} type="number" value={e.price ?? ""} onChange={(ev) => setExpense(i, { price: numOrNull(ev.target.value) })} title="Unit price" />
                      <span>×</span>
                      <input style={{ ...L, width: 44, textAlign: "right" }} type="number" value={e.pax ?? ""} onChange={(ev) => setExpense(i, { pax: numOrNull(ev.target.value) })} title="Quantity" />
                      <select style={{ ...L, width: 50, appearance: "none", WebkitAppearance: "none", textAlign: "center", backgroundImage: "none", cursor: "pointer" }} value={e.unit ?? "คน"} onChange={(ev) => setExpense(i, { unit: ev.target.value })} title="เลือกหน่วย">{UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}</select>
                    </span>
                  )}
                  <b>{thb(expenseAmount(e))}</b>
                </td>
                <td className="no-print">
                  {/* Duplicate protection, settable only on COMPANY_DIRECT rows: a cost
                      the guide fronted cannot already be in PEAK under a supplier's own
                      invoice. Marking it keeps the row in this job's cost but excludes it
                      from the payload, so it is never booked twice. The document number
                      is required by peakSyncEligibility — "it's already in there" without
                      saying where is an unverifiable claim that could hide a real expense. */}
                  {already
                    ? <span className="js-dupe">
                        <span className="js-acct done" title="Counted as this job's cost, never posted to PEAK again">Already recorded</span>
                        {canEdit && (
                          <>
                            <input value={e.sourceDocumentNo ?? ""} placeholder="Document no." title="Supplier invoice / receipt number this cost was booked under"
                              onChange={(ev) => setExpense(i, { sourceDocumentNo: ev.target.value, sourceDocumentType: e.sourceDocumentType || "SUPPLIER_INVOICE" })} />
                            <button type="button" className="btn sm ghost" title="This cost is not in PEAK yet — include it in the sync"
                              onClick={() => setExpense(i, { alreadyRecordedInPeak: false, sourceDocumentNo: undefined, sourceDocumentType: undefined })}>Undo</button>
                          </>
                        )}
                      </span>
                    : acct === "READY"
                      ? <span className="js-acct ok" title={`Maps to ${PEAK_SERVICE_COST_LABEL}`}>Ready to sync</span>
                      : acct === "UNMAPPED"
                        ? <span className="js-acct warn" title={expenseCategory(e) ? "No PEAK account is configured for this category yet" : "Choose an expense category so this line can be mapped to an account"}>{expenseCategory(e) ? "No account" : "Unmapped"}</span>
                        : <span className="js-acct warn" title={paid === "UNSPECIFIED" ? "Set Paid By — it decides whether the guide is reimbursed for this line" : "Other Tour Cost is never auto-approved — confirm the accounting mapping for this line"}>Needs review</span>}
                  {/* Per-row account for Other Tour Cost. Never guessed: until the
                      operator chooses one the row stays "Needs review" and blocks sync
                      (see expenseMappingStatus in lib/peak-sync). */}
                  {!already && canEdit && expenseCategory(e) === "other" && (
                    <div className="js-row-acct">
                      <input list="js-peak-accounts" value={e.peakAccountCode ?? ""} placeholder="Search PEAK account…"
                        title="Other Tour Cost has no standing account — choose the one this expense belongs to"
                        aria-label="PEAK account for this expense"
                        onChange={(ev) => {
                          const code = ev.target.value.trim();
                          const acct = peakAccounts.find((a) => a.code === code);
                          setExpense(i, { peakAccountCode: code || null, peakAccountName: acct?.name ?? null });
                        }} />
                      {e.peakAccountCode && <span>{e.peakAccountName || peakAccounts.find((a) => a.code === e.peakAccountCode)?.name || "not in the PEAK list"}</span>}
                    </div>
                  )}
                  {!already && canEdit && paid === "COMPANY_DIRECT" && (
                    <button type="button" className="btn sm ghost js-dupe-mark" title="This cost is already in PEAK under a supplier invoice or receipt — keep it in the job's cost but never post it again"
                      onClick={() => setExpense(i, { alreadyRecordedInPeak: true, sourceDocumentType: "SUPPLIER_INVOICE" })}>Already in PEAK</button>
                  )}
                </td>
                <td className="no-print">{canEdit && <button className="btn sm danger" title="Remove this expense line" onClick={() => up({ expenses: sheet.expenses.filter((_, j) => j !== i) })}>×</button>}</td>
              </tr>
              );
            })}
            {needsAccountPicker && canEdit && (
              <tr className="no-print"><td colSpan={8} style={{ padding: 0, border: 0 }}>
                <datalist id="js-peak-accounts">
                  {peakAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </datalist>
              </td></tr>
            )}
            <tr className="js-total">
              <td colSpan={5} style={{ textAlign: "right" }}>TOTAL TOUR EXPENSES<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"รวมค่าใช้จ่ายในการนำเที่ยว"}</small></td>
              <td className="js-amt"><b>{thb(cost.tourExpenses)}</b></td>
              <td className="no-print">
                {/* Reflects the expense ROWS only. A missing guide contact blocks the
                    sheet but says nothing about this table — flagging it here would
                    send the operator hunting through rows that are all correct. */}
                {peak?.rowsReady
                  ? <span className="js-acct ok" title={`Every expense line has an accepted account (${PEAK_SERVICE_COST_LABEL})`}>Ready to sync</span>
                  : <span className="js-acct warn" title="One or more lines have no accepted accounting category yet">Needs review</span>}
              </td>
              <td className="no-print" />
            </tr>
          </tbody>
        </table>
        {!ro && (() => {
          // Flag clearly unusual quantities vs the job's passenger count (guests
          // + guide). Warn only — the operator may proceed if it's intentional.
          const guests = sheet.bookings.reduce((a, b) => a + (b.actualPax ?? b.bookedPax ?? 0), 0);
          const cap = Math.max(2, Math.ceil((guests + 1) * 1.5));
          const odd = guests > 0 ? sheet.expenses.filter((e) => (e.pax ?? 0) > cap && expenseAmount(e) > 0) : [];
          return odd.length ? (
            <div className="no-print" style={{ margin: "6px 0 8px", padding: "8px 12px", borderRadius: 8, background: "#fdf3e7", border: "1px solid #ecd9bf", color: "#b45309", fontSize: 12.5, fontWeight: 600 }}>
              ⚠ {odd.map((e) => `${e.description || "?"} (Qty ${e.pax})`).join(", ")} — this quantity is unusually high compared with the job passenger count ({guests} pax). Please review before finalizing.<br />
              <span style={{ fontWeight: 500 }}>จำนวนรายการนี้สูงกว่าจำนวนผู้เดินทางอย่างมีนัยสำคัญ กรุณาตรวจสอบก่อนบันทึก Job Sheet</span>
            </div>
          ) : null;
        })()}
        <button className="btn sm no-print" onClick={() => up({ expenses: [...sheet.expenses, { description: "", price: null, pax: null }] })}>+ Add expense</button>
        {!ro && (() => {
          // Expense pax starts blank — the operator enters the guest count once here
          // and fills every line (attraction/ticket lines get the count, "(Inc. Guide)"
          // lines get +1). They can still tweak any line by hand afterwards.
          const guestTotal = sheet.bookings.reduce((s, b) => s + (b.actualPax ?? b.bookedPax ?? 0), 0);
          return (
            <span className="no-print" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--ink-soft,#888)" }}>Fill down pax:</span>
              <input type="number" min={0} value={fillPax} placeholder={String(guestTotal || "")} onChange={(e) => setFillPax(e.target.value)} style={{ ...L, width: 72 }} title="Guest count to apply to every expense line (Inc. Guide +1)" />
              <button className="btn sm" title="Set every expense line's pax from this guest count" onClick={() => { const p = fillPax.trim() === "" ? guestTotal : Math.max(0, Math.floor(Number(fillPax) || 0)); up({ expenses: fillDownExpensePax(sheet.expenses, p) }); }}>Fill down</button>
            </span>
          );
        })()}

        {/* Guide-reported expenses — cross-check (operator only). Once the sheet is
            APPROVED the review is decided — collapse to a closure line (the full
            comparison stays one click away for audit). */}
        {canEdit && sheet.guideExpenses && sheet.guideExpenses.length > 0 && isApproved(sheet.approvalStatus) && (
          <div className="no-print" style={{ marginTop: 18, border: "1px solid var(--ok-line,#cfe6d6)", background: "var(--ok-bg,#eef7f0)", borderRadius: 10, padding: "9px 12px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: "var(--green,#2f7d4f)", fontSize: 13 }}>✓ Guide report reviewed — official figures approved<span style={{ display: "block", fontSize: 10.5, fontWeight: 500 }}>ตรวจสอบรายงานไกด์แล้ว — ยึดตามตัวเลขที่อนุมัติ</span></span>
            {sheet.approvedAt && <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{new Date(sheet.approvedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
            <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setShowCross((v) => !v)}>{showCross ? "Hide comparison" : "Show comparison"}</button>
          </div>
        )}
        {canEdit && sheet.guideExpenses && sheet.guideExpenses.length > 0 && (!isApproved(sheet.approvalStatus) || showCross) && (() => {
          const opTot = sheet.expenses.reduce((s, e) => s + expenseAmount(e), 0);
          const gdTot = sheet.guideExpenses!.reduce((s, e) => s + expenseAmount(e), 0);
          return (
            <div className="no-print" style={{ marginTop: 18, border: "1px solid #ecd9bf", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: "#fff8c4", padding: "7px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b style={{ fontSize: 13 }}>Guide-reported expenses · cross-check</b>
                <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>{sheet.guideExpensesAt ? `reported ${new Date(sheet.guideExpensesAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
              </div>
              {sheet.guideExpensesNote && <div style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--ink)", background: "#fffdf4", borderBottom: "1px solid #f0e6cf" }}><b style={{ color: "var(--ink-soft)", fontWeight: 600 }}>Guide note: </b>{sheet.guideExpensesNote}</div>}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ background: "#f4f4f4", fontSize: 10.5, textTransform: "uppercase", color: "var(--ink-soft)" }}>
                  <th style={{ textAlign: "left", padding: "5px 10px" }}>Description</th><th style={{ textAlign: "right", padding: "5px 10px" }}>Operator</th><th style={{ textAlign: "right", padding: "5px 10px", color: "var(--primary)" }}>Guide</th><th style={{ textAlign: "right", padding: "5px 10px" }}>Check</th>
                </tr></thead>
                <tbody>
                  {crossRows.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #eee", background: r.flag === "differ" ? "#fdf3e7" : r.flag === "added" ? "#eef4ec" : undefined }}>
                      <td style={{ padding: "5px 10px" }}>{r.desc}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.oa == null ? "—" : thb(r.oa)}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: r.flag === "differ" || r.flag === "added" ? 700 : 400, color: r.flag === "differ" ? "#b45309" : r.flag === "added" ? "#2e7d4f" : "inherit" }}>{r.ga == null ? "—" : thb(r.ga)}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", color: r.flag === "match" ? "#2e7d4f" : r.flag === "differ" ? "#b45309" : r.flag === "added" ? "#2e7d4f" : "var(--ink-soft)" }}>
                        {r.flag === "match" ? "✓" : r.flag === "differ" ? "⚠ differs" : r.flag === "added" ? "+ added" : "operator only"}
                        {(r.flag === "differ" || r.flag === "added") && r.g && (
                          <button className="btn sm ghost" style={{ marginLeft: 8 }} title={r.flag === "added" ? "Add this guide-reported line to the official expenses (adjust, then Save)" : "Use the guide's figure for this line only (adjust, then Save)"} onClick={() => adoptGuideLine(r)}>← {r.flag === "added" ? "Add" : "Use"}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: "2px solid #ddd", background: "#fafafa", fontWeight: 800 }}>
                    <td style={{ padding: "6px 10px" }}>Total</td>
                    <td style={{ padding: "6px 10px", textAlign: "right" }}>{thb(opTot)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--primary)" }}>{thb(gdTot)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: Math.round(opTot) === Math.round(gdTot) ? "#2e7d4f" : "#b45309" }}>{Math.round(opTot) === Math.round(gdTot) ? "✓" : `Δ ${thb(Math.abs(gdTot - opTot))}`}</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ padding: "10px 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn sm primary" disabled={busy} onClick={acceptGuideExpenses}>{busy ? "Saving…" : "Accept guide’s figures"}</button>
                {!isApproved(sheet.approvalStatus) && (
                  <button className="btn sm" disabled={busy} title="Keep the official (operator) figures, approve the sheet, and close this review — the guide's report stays for audit" onClick={() => { if (confirm(`Keep the official figures (${thb(opTot)}) and approve this sheet?\n\nThe guide's report (${thb(gdTot)}) stays recorded for audit.`)) toggleApprove(); }}>✓ Keep operator’s figures · ยึดตาม Operator</button>
                )}
                <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>accept = use the guide’s numbers · keep = the official numbers stand and the sheet is approved</span>
              </div>
            </div>
          );
        })()}

        </div>

        {/* Guide fee */}
        <div style={{ display: secTab === "all" || secTab === "fee" ? undefined : "none" }}>
        <div style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
        {/* GUIDE PAYMENT — the guide's earning for this job. Kept strictly out of
            Tour Expenses: this is what the company OWES the guide, not what the tour
            cost. Every figure comes from computeTotals (lib/jobsheet) — the same math
            Payments pays on; nothing is recalculated here. */}
        <h3 className="js-section" style={{ background: "#f4d9c4" }}>GUIDE PAYMENT<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"ค่าจ้างมัคคุเทศก์"}</small></h3>
        <table className="js-table js-pay-table">
          <tbody>
            <tr>
              <td><TH en="Guide Fee" th="ค่าจ้างมัคคุเทศก์" /></td>
              <td className="js-amt">
                {!ro && (
                  <span className="js-amt-in no-print">
                    <input style={{ ...L, width: 84, textAlign: "right" }} type="number" value={sheet.guideFee.price ?? ""} onChange={(e) => up({ guideFee: { ...sheet.guideFee, price: numOrNull(e.target.value) } })} title="Agreed rate" />
                    <span>×</span>
                    <input style={{ ...L, width: 44, textAlign: "right" }} type="number" value={sheet.guideFee.time ?? ""} onChange={(e) => up({ guideFee: { ...sheet.guideFee, time: numOrNull(e.target.value) } })} title="Number of times/days" />
                  </span>
                )}
                <b>{thb(t.gross)}</b>
              </td>
            </tr>
            <tr>
              <td><TH en="WHT %" th="อัตราภาษีหัก ณ ที่จ่าย" /></td>
              <td className="js-amt">
                {!ro && <span className="js-amt-in no-print"><input style={{ ...L, width: 52, textAlign: "right" }} type="number" value={sheet.guideFee.whtPct ?? ""} onChange={(e) => up({ guideFee: { ...sheet.guideFee, whtPct: numOrNull(e.target.value) } })} title="Withholding tax rate on the guide fee — applies to the fee only, never to tour expenses" /></span>}
                <b>{sheet.guideFee.whtPct ?? 0}%</b>
              </td>
            </tr>
            <tr><td><TH en="WHT Amount" th="ภาษีหัก ณ ที่จ่าย" /></td><td className="js-amt"><b>{thb(t.wht)}</b></td></tr>
            <tr className="js-total"><td><TH en="Net to Pay" th="ยอดจ่ายสุทธิ" /></td><td className="js-amt"><b>{thb(t.netGuideFee)}</b></td></tr>
          </tbody>
        </table>

        {/* Additional Guide Payment — review rewards are guide compensation, not
            tour operating cost. A reward earned on ANOTHER job (Related Job No.
            differs) is paid out with this job but never counted as its expense. */}
        {(() => {
          const rows = sheet.expenses.map((e, i) => ({ e, i })).filter(({ e }) => isReviewExpense(e));
          if (!rows.length && ro) return null;
          return (
            <div style={{ marginTop: 14, breakInside: "avoid", pageBreakInside: "avoid" }}>
              <h3 className="js-section" style={{ background: "#efe7f3" }}>Additional Guide Payment / Review Reward<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"รายการจ่ายเพิ่มเติมให้มัคคุเทศก์"}</small><span className="js-sub">Separate from tour expenses and the base guide fee</span></h3>
              <table className="js-table">
                <thead><tr>
                  <th style={{ textAlign: "left" }}><TH en="Payment Type" th="ประเภทการจ่าย" /></th>
                  <th style={{ width: 150 }}><TH en="Related Job No." th="เลขที่การจองที่รีวิว" /></th>
                  <th className="no-print" style={{ width: 180 }}><TH en="Note" th="หมายเหตุ" /></th>
                  <th style={{ width: 120, textAlign: "right" }}><TH en="Amount" th="จำนวนเงิน" /></th>
                  <th className="no-print" style={{ width: 34 }} />
                </tr></thead>
                <tbody>
                  {rows.map(({ e, i }) => {
                    const own = reviewBelongsToJob(e, sheet.ref, sheet.bookings);
                    return (
                      <tr key={i}>
                        {/* Payment Type is still stored as the row's description, and
                            isReviewExpense() classifies a row by that text starting with
                            "Review" (lib/jobsheet) — it decides payouts, the PDF and the
                            guide's Pay screen. So a type that drops the prefix would move
                            this row into Tour Expenses. Warn in place rather than silently
                            reclassifying; giving these rows their own stored kind is a
                            data migration, out of scope here. */}
                        <td>{ro ? (e.description || "Review Reward") : <input style={{ ...L, ...(isReviewExpense(e) ? {} : { borderColor: "var(--danger)" }) }} value={e.description} title='Must start with "Review" (e.g. "Review reward") — this is what keeps the row in Additional Guide Payment instead of Tour Expenses.' onChange={(ev) => setExpense(i, { description: ev.target.value })} />}<small style={{ display: "block", fontSize: 9.5, color: "var(--ink-soft)" }}>ค่าตอบแทนรีวิว{own ? "" : " · จ่ายพร้อมงานนี้ ไม่ใช่ต้นทุนของงานนี้"}</small></td>
                        <td>{ro ? (e.relatedBookingNo || e.relatedJobRef || "—") : <input style={{ ...L, fontFamily: "monospace", fontSize: 12 }} value={e.relatedBookingNo ?? ""} placeholder="GYG… (เว้นว่าง = แขกงานนี้)" title="Booking no. of the guest who left the review — a booking on this job's guest list counts as this job's cost; any other booking is paid out here without inflating this job" onChange={(ev) => setExpense(i, { relatedBookingNo: ev.target.value })} />}</td>
                        <td className="no-print">{ro ? (e.notes || "—") : <input style={L} value={e.notes ?? ""} placeholder="e.g. great review from customer" onChange={(ev) => setExpense(i, { notes: ev.target.value })} />}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{ro ? thb(expenseAmount(e)) : <span style={{ display: "inline-flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}><input style={{ ...L, width: 58, textAlign: "right" }} type="number" value={e.price ?? ""} onChange={(ev) => setExpense(i, { price: numOrNull(ev.target.value) })} />×<input style={{ ...L, width: 40, textAlign: "right" }} type="number" value={e.pax ?? ""} onChange={(ev) => setExpense(i, { pax: numOrNull(ev.target.value) })} /></span>}</td>
                        <td className="no-print">{canEdit && <button className="btn sm danger" onClick={() => up({ expenses: sheet.expenses.filter((_, j) => j !== i) })}>×</button>}</td>
                      </tr>
                    );
                  })}
                  {rows.length > 0 && (
                    <tr className="js-total">
                      <td colSpan={3} style={{ textAlign: "right" }}>Total Additional Payment<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"รวมรายการจ่ายเพิ่มเติม"}</small></td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}><b>{thb(cost.reviewOwn + cost.reviewOther)}</b></td>
                      <td className="no-print" />
                    </tr>
                  )}
                </tbody>
              </table>
              {canEdit && <button className="btn sm no-print" title="Reward for reviews — rate × number of reviews (e.g. 2 × ฿50)" onClick={() => up({ expenses: [...sheet.expenses, { description: "Review reward", price: 50, pax: 1 }] })}>★ + Review reward</button>}
            </div>
          );
        })()}
        </div>


        </div>


       </fieldset>

       {/* Advance / Settlement — money sent to the guide BEFORE the tour, the spend
           from it (paidBy = "Guide Advance" expense rows above) and what came back.
           A cash-movement ledger: it never adds to the expense total. Lives outside
           the read-only fieldset so the GUIDE can still record their return. */}
       {(hasAdvance || canEdit) && (
       <div className="advance-settlement" style={{ display: secTab === "all" || secTab === "expenses" ? undefined : "none", marginTop: 16 }}>
        <h3 className="js-section" style={{ background: "#e8f1ea", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span>Advance / Settlement<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"การเคลียร์เงินทดรองจ่าย"}</small></span>
          <span className="no-print">{advChip}</span>
        </h3>
        {hasAdvance ? (
          <>
            <table className="js-table" style={{ fontSize: 13 }}>
              <thead><tr>
                <th style={{ textAlign: "left" }}>Description<small style={{ display: "block", fontSize: 9, fontWeight: 500, color: "var(--ink-soft)" }}>รายการ</small></th>
                <th style={{ width: 155 }}>Date · Time<small style={{ display: "block", fontSize: 9, fontWeight: 500, color: "var(--ink-soft)" }}>วันเวลาทำรายการ</small></th>
                <th className="no-print" style={{ width: 70 }}>Slip<small style={{ display: "block", fontSize: 9, fontWeight: 500, color: "var(--ink-soft)" }}>สลิป</small></th>
                <th style={{ width: 110, textAlign: "right" }}>Amount<small style={{ display: "block", fontSize: 9, fontWeight: 500, color: "var(--ink-soft)" }}>จำนวนเงิน</small></th>
                <th className="no-print" style={{ width: 34 }} />
              </tr></thead>
              <tbody>
                {advance.advances.map((a) => (
                  <tr key={a.id}>
                    <td>Advance Paid<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"เงินทดรองจ่ายให้มัคคุเทศก์"}</small>{a.txRef ? <span style={{ color: "var(--ink-soft)", fontSize: 11.5 }}> · {a.txRef}</span> : null}{a.note ? <span style={{ color: "var(--ink-soft)", fontSize: 11.5 }}> · {a.note}</span> : null}</td>
                    <td style={{ whiteSpace: "nowrap", fontSize: 12.5, color: "var(--ink-soft)" }}>{dtShort(a.paidAt)} · {a.method}</td>
                    <td className="no-print" style={{ textAlign: "center" }}>{a.slipUrl ? <a href={a.slipUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 700 }}>📎 Slip</a> : <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>—</span>}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(a.amount)}</td>
                    <td className="no-print" style={{ textAlign: "center" }}>{canEdit && <button className="btn sm danger" disabled={advBusy} title="Remove (kept in audit log)" onClick={() => removeAdvanceRow("advance", a)}>×</button>}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ paddingLeft: 18 }}>Expenses Paid from Advance<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"ค่าใช้จ่ายที่ชำระจากเงินทดรอง"}</small></td>
                  <td /><td className="no-print" />
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>− {thb(advT.usedFromAdvance)}</td>
                  <td className="no-print" />
                </tr>
                {sheet.expenses.filter((e) => e.paidBy === "advance" && expenseAmount(e) > 0).map((e, i) => (
                  <tr key={`adv-exp-${i}`} style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    <td style={{ paddingLeft: 34 }}>{e.description}</td>
                    <td /><td className="no-print" />
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{thb(expenseAmount(e))}</td>
                    <td className="no-print" />
                  </tr>
                ))}
                {advance.returns.map((a) => (
                  <tr key={a.id}>
                    <td style={{ paddingLeft: 18 }}>Advance Returned<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"เงินทดรองคงเหลือส่งคืน"}</small>{a.txRef ? <span style={{ color: "var(--ink-soft)", fontSize: 11.5 }}> · {a.txRef}</span> : null}{a.note ? <span style={{ color: "var(--ink-soft)", fontSize: 11.5 }}> · {a.note}</span> : null}</td>
                    <td style={{ whiteSpace: "nowrap", fontSize: 12.5, color: "var(--ink-soft)" }}>{dtShort(a.returnedAt)} · {a.method}</td>
                    <td className="no-print" style={{ textAlign: "center" }}>{a.slipUrl ? <a href={a.slipUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 700 }}>📎 Slip</a> : <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>—</span>}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>− {thb(a.amount)}</td>
                    <td className="no-print" style={{ textAlign: "center" }}>{canEdit && <button className="btn sm danger" disabled={advBusy} title="Remove (kept in audit log)" onClick={() => removeAdvanceRow("return", a)}>×</button>}</td>
                  </tr>
                ))}
                <tr className="js-total">
                  <td colSpan={2} style={{ textAlign: "right" }}>Outstanding Advance<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"เงินทดรองจ่ายคงค้าง"}</small></td>
                  <td className="no-print" />
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: advT.outstanding < 0 ? "var(--danger)" : advT.outstanding === 0 ? "var(--green,#2f7d4f)" : "inherit" }}><b>{thb(advT.outstanding)}</b></td>
                  <td className="no-print" />
                </tr>
              </tbody>
            </table>
            {advSt === "OVER_RETURNED" && (
              <div style={{ margin: "8px 0 0", padding: "8px 12px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-line)", color: "var(--danger)", fontWeight: 600, fontSize: 12.5 }}>
                ⚠ Returned amount exceeds the remaining advance. Please review the settlement — check the expense rows’ payment source and the recorded amounts.
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", padding: "6px 2px" }}>No advance issued for this job. Record one if money was transferred to the guide before the tour — the actual spend then goes in the expense rows above with source “Guide Advance”.</div>
        )}

        {/* Record forms — operator records advances and returns; the guide may record
            their own RETURN (they made the transfer back) but never an advance. */}
        <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          {canEdit && <button className="btn sm" disabled={advBusy} onClick={() => { setAdvKind(advKind === "advance" ? null : "advance"); setAdvForm((f) => ({ ...f, amount: "", txRef: "", note: "" })); }}>{advKind === "advance" ? "Cancel" : "+ Record advance"}</button>}
          {(canEdit || (hasAdvance && advT.outstanding > 0)) && <button className="btn sm" disabled={advBusy} onClick={() => { setAdvKind(advKind === "return" ? null : "return"); setAdvForm((f) => ({ ...f, amount: advT.outstanding > 0 ? String(advT.outstanding) : "", txRef: "", note: "" })); }}>{advKind === "return" ? "Cancel" : "+ Record return"}</button>}
          {hasAdvance && <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>Advance {thb(advT.totalAdvancePaid)} · Used {thb(advT.usedFromAdvance)} · Returned {thb(advT.totalReturned)} · Balance {thb(advT.outstanding)}</span>}
        </div>
        {advKind && (
          <div className="no-print" style={{ marginTop: 8, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--grey-bg,#fafafa)", display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Amount (฿)<br />
              <input style={{ ...L, width: 110, marginTop: 2 }} type="number" min={1} value={advForm.amount} onChange={(e) => setAdvForm((f) => ({ ...f, amount: e.target.value }))} placeholder="1000" /></label>
            <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>{advKind === "advance" ? "Paid at" : "Returned at"}<br />
              <input style={{ ...L, width: 190, marginTop: 2 }} type="datetime-local" value={advForm.at} onChange={(e) => setAdvForm((f) => ({ ...f, at: e.target.value }))} title="Leave blank for now" /></label>
            <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Method<br />
              <select style={{ ...L, width: 120, marginTop: 2 }} value={advForm.method} onChange={(e) => setAdvForm((f) => ({ ...f, method: e.target.value }))}>
                <option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option>
              </select></label>
            <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Transfer ref (optional)<br />
              <input style={{ ...L, width: 150, marginTop: 2 }} value={advForm.txRef} onChange={(e) => setAdvForm((f) => ({ ...f, txRef: e.target.value }))} /></label>
            <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Note (optional)<br />
              <input style={{ ...L, width: 170, marginTop: 2 }} maxLength={500} value={advForm.note} onChange={(e) => setAdvForm((f) => ({ ...f, note: e.target.value }))} /></label>
            <label className="btn sm" style={{ cursor: "pointer" }} title="Attach the transfer slip (image or PDF, max 10 MB)">
              {advForm.file ? `📎 ${advForm.file.name.slice(0, 18)}…` : "📎 Slip"}
              <input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0] ?? null; setAdvForm((prev) => ({ ...prev, file: f })); e.target.value = ""; }} />
            </label>
            <button className="btn sm primary" disabled={advBusy} onClick={() => submitAdvance(advKind)}>{advBusy ? "…" : advKind === "advance" ? "Record advance" : "Record return"}</button>
          </div>
        )}
       </div>
       )}

       {/* Financial Summary — placed BELOW Advance/Settlement per owner: the
           final money recap right before certification. */}
       <div style={{ display: secTab === "all" || secTab === "fee" ? undefined : "none", marginTop: 16 }}>
        {/* Financial Summary — accounting presentation (see lib/jobsheet helpers):
            Total Job Expenses = tour expenses + GROSS guide fee; WHT shown
            separately and never subtracted from job expenses. Advance lines are
            cash movements, never added to totals. The Payments payout figure
            (expenses + net fee) is a different number and lives in Payments. */}
        {(() => {
          return (
        <>
        <div className="js-summary" style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>SUMMARY<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>สรุปรายการทางการเงิน</small></div>
          {/* Company cost. Every figure is read from jobCostBreakdown/computeTotals —
              the expense rows are summed ONCE, there (lib/jobsheet). A review reward
              earned on ANOTHER job is paid out with this transfer but is deliberately
              not part of this job's cost, so it sits outside the Total. */}
          {/* Only the three full-weight lines sum into Total Company Cost. The
              indented "of which" lines are BREAKDOWNS of the line above them:
              WHT is withheld from the guide's fee and remitted, not extra cost,
              and Reimbursement Due is the guide-paid SUBSET of tour expenses —
              adding either would double-count. Listed flat, they made the total
              look like it did not add up. */}
          <div><span>Total Tour Expenses{flagged("totalTourExpenses") && <em className="js-recheck-tag">recheck</em>}<small style={{ display: "block", fontSize: 9.5, color: "var(--ink-soft)", fontWeight: 400 }}>ค่าใช้จ่ายในการนำเที่ยว (ต้นทุนบริษัท)</small></span><b>{thb(money.totalTourExpenses)}</b></div>
          <div className="js-sum-sub"><span>of which reimbursable to guide{flagged("reimbursementDue") && <em className="js-recheck-tag">recheck</em>}<small>ยอดที่ต้องคืนให้มัคคุเทศก์ (สำรองจ่าย)</small></span><b style={{ color: money.reimbursementDue > 0 ? "#b45309" : undefined }}>{thb(money.reimbursementDue)}</b></div>
          {money.companyDirectTotal > 0 && <div className="js-sum-sub"><span>of which paid direct by company<small>บริษัทชำระโดยตรง</small></span><b>{thb(money.companyDirectTotal)}</b></div>}
          {money.unspecifiedTotal > 0 && <div className="js-sum-sub warn"><span>of which Paid By not set<small>ยังไม่ระบุแหล่งเงิน</small></span><b>{thb(money.unspecifiedTotal)}</b></div>}
          <div><span>Guide Fee<small style={{ display: "block", fontSize: 9.5, color: "var(--ink-soft)", fontWeight: 400 }}>ค่าจ้างมัคคุเทศก์</small></span><b>{thb(money.guideFeeGross)}</b></div>
          <div className="js-sum-sub"><span>of which withheld as tax (WHT)<small>ภาษีหัก ณ ที่จ่าย — นำส่งสรรพากร</small></span><b>{thb(money.wht)}</b></div>
          <div className="grand"><span>Total Company Cost<small style={{ display: "block", fontSize: 9.5, color: "var(--ink-soft)", fontWeight: 400 }}>รวมต้นทุน</small></span><b>{thb(money.totalCompanyCost)}</b></div>
          {/* Total Company Cost is what the job cost; it is NOT what to transfer.
              Reading one as the other is the mistake this line exists to prevent. */}
          <div className="js-sum-hand">what the job cost — not the amount to transfer ↓</div>
          {cost.reviewOther > 0 && <div className="js-sum-note"><span>Paid with this job, earned on another<small style={{ display: "block", fontSize: 9.5, color: "var(--ink-soft)", fontWeight: 400 }}>จ่ายพร้อมงานนี้ ไม่ใช่ต้นทุนของงานนี้</small></span><b>{thb(cost.reviewOther)}</b></div>}
        </div>

        {/* What the guide actually receives, and where that payment stands. Kept
            visually apart from company cost — they are different questions.
            Net Pay to Guide is computeTotals().grandTotal, the exact figure Payments
            transfers; it is never re-derived here. */}
        <div className="js-netpay" style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
          <div className="js-netpay-main">
            {/* The one number an operator acts on. Everything above it is cost
                reporting; this is the transfer. Say that outright rather than
                leaving them to work out which figure to use. */}
            <span>Transfer to guide{flagged("netPayToGuide") && <em className="js-recheck-tag">recheck</em>}<small>ยอดที่ต้องโอนให้มัคคุเทศก์</small></span>
            <b>{thb(money.netPayToGuide)}</b>
          </div>
          {/* Show how the figure is built. Without this, a sheet whose expenses were
              all settled by the company looks like the tour expenses simply vanished
              between the Summary above and this box. */}
          <div className="np-parts">
            <div><span>Guide fee after WHT</span><b>{thb(money.netGuideFee)}</b></div>
            {money.additionalGuidePayment > 0 && <div><span>Additional payment</span><b>{thb(money.additionalGuidePayment)}</b></div>}
            <div><span>Reimbursement for expenses</span><b>{thb(money.reimbursementDue)}</b></div>
            {money.settledByCompany > 0 && (
              <div className="np-note">
                <span>{thb(money.settledByCompany)} of tour expenses is not paid here — the company already settled it{money.advanceSpentTotal > 0 ? " (guide advance)" : " (paid direct)"}.</span>
              </div>
            )}
            {money.unspecifiedTotal > 0 && (
              <div className="np-note warn">
                <span>{thb(money.unspecifiedTotal)} has no Paid By set, so it is being paid to the guide. Tag those rows if the company settled them.</span>
              </div>
            )}
          </div>
          <div className="js-netpay-status">
            <span>Payment Status<small>สถานะการจ่ายเงิน</small></span>
            {payment?.paid
              ? <span className="badge active">✓ Paid{payment.paidAt ? ` · ${new Date(payment.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}</span>
              : payment?.status === "APPROVED"
                ? <span className="badge pending">Approved — not yet paid</span>
                : <span className="badge muted">Pending</span>}
          </div>
          {/* Payments still transfers expenses + net fee, company-direct rows
              included. Until that screen adopts this formula the two figures differ,
              and hiding that would let someone pay the wrong amount believing the
              sheet agreed with it. */}
          {/* Everything that makes a figure above provisional, itemised. A quiet
              one-liner was too easy to read past on a number someone is about to
              transfer money against. */}
          {recheck.length > 0 && (
            <div className="js-recheck">
              <div className="js-recheck-head">Recheck before paying<span>{recheck.length} thing{recheck.length === 1 ? "" : "s"} to confirm</span></div>
              <ul>
                {recheck.map((r, i) => (
                  <li key={i}>
                    <b>{r.short}{r.amount ? ` · ${thb(r.amount)}` : ""}</b>
                    <span>{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Job notes — kept in the summary area where the money is read. Uses the
            existing operatorNote field; editable only where the sheet is. */}
        {(canEdit || (sheet.operatorNote ?? "").trim()) && (
          <div className="js-notes no-print" style={{ marginTop: 12 }}>
            <div className="js-notes-label">Notes<small>หมายเหตุ</small></div>
            {canEdit
              ? <textarea value={sheet.operatorNote ?? ""} maxLength={2000} onChange={(e) => up({ operatorNote: e.target.value })} rows={2} placeholder="Internal operations note — not shown to the guide" />
              : <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{sheet.operatorNote}</div>}
          </div>
        )}
        </>
          );
        })()}
       </div>

       {/* Certified by — the document sign-off. Fixed authorized certifier (see
           lib/certifier); the date is the sheet's FIRST successful save, stamped
           server-side — never the tour date, never changed by reopening. Printable,
           and kept together on one page. */}
       <div className="js-certify" style={{ marginTop: 26, borderTop: "1px dashed var(--line,#d9d9d9)", paddingTop: 14, breakInside: "avoid", pageBreakInside: "avoid" }}>
         <div style={{ textAlign: "center", width: "100%" }}>
           <div style={{ fontSize: 10.5, color: "var(--ink-soft,#777)", lineHeight: 1.6, textAlign: "left", marginBottom: 12 }}>{CERT_STATEMENT_TH}</div>
           <div style={{ fontSize: 11, color: "var(--ink-soft,#888)", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600 }}>Certified by</div>
           {/* eslint-disable-next-line @next/next/no-img-element */}
           <img
             src={JOB_SHEET_CERTIFIER.signatureUrl}
             alt={`Signature of ${JOB_SHEET_CERTIFIER.nameTh}`}
             style={{ maxWidth: "min(180px, 100%)", width: "auto", height: "auto", objectFit: "contain", display: "block", margin: "6px auto -4px", userSelect: "none", pointerEvents: "none" }}
             draggable={false}
             onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; console.warn("Job-sheet certifier signature failed to load:", JOB_SHEET_CERTIFIER.signatureUrl); }}
           />
           <div style={{ fontWeight: 600, marginTop: 8 }}>({JOB_SHEET_CERTIFIER.nameFullTh})</div>
           <div style={{ fontSize: 11, color: "var(--ink-soft,#777)" }}>{JOB_SHEET_CERTIFIER.roleLabelTh}</div>
           <div style={{ fontSize: 12.5, color: "var(--ink-soft,#666)", marginTop: 4 }}>{(() => { const d = fmtCertDate(certificationDate(sheet)); return d ? `วันที่ ${d}` : canEdit ? "date set on first save" : "\u2014"; })()}</div>
         </div>
       </div>
       {/* HISTORY & FILES — everything here is a record that already exists:
           timeline events come from the sheet/assignment/check-in/report/payment
           timestamps and the audit log (assembled in /api/jobsheet); files are the
           receipts, advance slips and payment slip already stored in Drive. Nothing
           is synthesised, so an empty tab means nothing was recorded. */}
       {canEdit && (
       <div className="js-history no-print">
         <h3 className="js-section" style={{ background: "#eef0f3" }}>HISTORY &amp; FILES<small style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-soft,#8a8f8b)", marginLeft: 5 }}>{"ประวัติและเอกสาร"}</small></h3>
         <div className="subtabs" style={{ margin: "10px 0" }}>
           {([["timeline", "Timeline"], ["files", "Files"]] as const).map(([k, l]) => (
             <button key={k} type="button" className={`subtab${histTab === k ? " active" : ""}`} onClick={() => setHistTab(k)}>{l}</button>
           ))}
         </div>
         {histTab === "timeline" ? (
           history.length ? (
             <ol className="js-timeline">
               {history.map((h, i) => (
                 <li key={i}>
                   <span className="js-tl-at">{dtShort(h.at)}</span>
                   <span className="js-tl-label">{h.label}</span>
                   {h.by && <span className="js-tl-by">{h.by}</span>}
                 </li>
               ))}
             </ol>
           ) : <div className="op-empty" style={{ padding: 14 }}>No recorded events for this job yet.</div>
         ) : (() => {
           const files: { name: string; url: string; kind: string }[] = [];
           sheet.expenses.forEach((e, i) => { if (e.receiptUrl) files.push({ name: e.receiptName || `Receipt ${i + 1}`, url: e.receiptUrl, kind: `Receipt · ${e.description || "expense"}` }); });
           advance.advances.forEach((a) => { if (a.slipUrl) files.push({ name: `Advance slip · ${thb(a.amount)}`, url: a.slipUrl, kind: "Guide advance" }); });
           advance.returns.forEach((a) => { if (a.slipUrl) files.push({ name: `Return slip · ${thb(a.amount)}`, url: a.slipUrl, kind: "Advance return" }); });
           if (payment?.slip) files.push({ name: "Payment slip", url: payment.slip, kind: "Guide payment" });
           return files.length ? (
             <table className="js-table">
               <thead><tr><th><TH en="File" th="เอกสาร" /></th><th style={{ width: 220 }}><TH en="Type" th="ประเภท" /></th><th style={{ width: 70 }} /></tr></thead>
               <tbody>
                 {files.map((f, i) => (
                   <tr key={i}>
                     <td style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</td>
                     <td style={{ color: "var(--ink-soft)" }}>{f.kind}</td>
                     <td><a className="btn sm" href={f.url} target="_blank" rel="noopener noreferrer">Open</a></td>
                   </tr>
                 ))}
               </tbody>
             </table>
           ) : <div className="op-empty" style={{ padding: 14 }}>No files attached to this job yet.</div>;
         })()}
       </div>
       )}
      </section>

      {/* Finance / accounting side panel — operator-only snapshot of where this job
          stands on the money side. Read state lives here; money ACTIONS stay on
          their own screens (Payments / Payment batches). */}
      {canEdit && (
        <aside className="panel no-print js-fin-side" style={{ padding: "14px 16px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Finance & accounting</h3>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)", fontWeight: 700 }}>Approval</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              {isApproved(sheet.approvalStatus)
                ? <span className="badge active">✓ Approved</span>
                : <span className="badge muted">Not approved</span>}
              <button className="btn sm" disabled={busy} onClick={toggleApprove}>{isApproved(sheet.approvalStatus) ? "Unapprove" : "Approve"}</button>
            </div>
            {sheet.approvedAt && <div style={{ fontSize: 11.5, color: "var(--ink-soft)", marginTop: 3 }}>{new Date(sheet.approvedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>}
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)", fontWeight: 700 }}>Payment</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              {payment?.paid
                ? <span className="badge active">✓ Paid</span>
                : payment?.status === "APPROVED"
                  ? <span className="badge pending">Approved</span>
                  : <span className="badge muted">Pending</span>}
              {payment?.paidAt && <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{new Date(payment.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
              {payment?.slip && <a href={payment.slip} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 700 }}>Slip</a>}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 5 }}>Payable <b style={{ fontVariantNumeric: "tabular-nums" }}>{thb(money.netPayToGuide)}</b></div>
          </div>

          {hasAdvance && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)", fontWeight: 700 }}>Guide advance</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>{advChip}</div>
              <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                Advance {thb(advT.totalAdvancePaid)} · Used {thb(advT.usedFromAdvance)}<br />Returned {thb(advT.totalReturned)} · Balance <b style={{ color: advT.outstanding < 0 ? "var(--danger)" : "var(--ink)" }}>{thb(advT.outstanding)}</b>
              </div>
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)", fontWeight: 700 }}>PEAK accounting</div>
            {/* Read-only mirror of the ref recorded on Payments. This screen never
                creates a PEAK expense and never invents a number: no ref means no
                ref. There is no "last sync" line because nothing syncs yet — the
                app has no field for it, and a timestamp we cannot source would be
                a fabrication. */}
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--ink-soft)" }}>PEAK Expense</div>
            {(() => {
              const el = peak?.eligibility;
              const docNo = peak?.peakDocumentNo || payment?.peakRef;
              // Synced: show the real document number and when. Never a generated one.
              if (docNo) return (
                <>
                  <div style={{ marginTop: 2, fontFamily: "monospace", fontSize: 12.5, fontWeight: 700 }}>{docNo}</div>
                  {peak?.syncedAt && <div style={{ marginTop: 2, fontSize: 11.5, color: "var(--ink-soft)" }}>Synced {new Date(peak.syncedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</div>}
                  {!peak?.syncedAt && <div style={{ marginTop: 2, fontSize: 11.5, color: "var(--ink-soft)" }}>Recorded manually on Payments.</div>}
                  {el?.changedSinceSync && (
                    <div className="js-sync-warn">
                      <b>Accounting data changed after PEAK sync</b>
                      <span>Review the changes and update PEAK deliberately — nothing is re-posted automatically.</span>
                    </div>
                  )}
                </>
              );
              if (el?.status === "FAILED") return (
                <>
                  <div style={{ marginTop: 2, fontSize: 13, fontWeight: 700, color: "var(--danger)" }}>Sync failed</div>
                  {peak?.syncError && <div style={{ marginTop: 2, fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{peak.syncError}</div>}
                </>
              );
              if (el?.status === "SYNCING") return <div style={{ marginTop: 2, fontSize: 13, fontWeight: 700 }}>Syncing…</div>;
              if (el?.status === "READY") return (
                <>
                  <div style={{ marginTop: 2, fontSize: 13, fontWeight: 700, color: "var(--green)" }}>Ready to sync</div>
                  <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>Posting is not enabled yet — the ref is recorded on Payments.</div>
                </>
              );
              // Not ready / blocked: say exactly what to fix, not just that it failed.
              return (
                <>
                  <div style={{ marginTop: 2, fontSize: 13, fontWeight: 700 }}>Not ready</div>
                  {el?.reasons?.length ? (
                    <ul className="js-sync-reasons">{el.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  ) : <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-soft)" }}>Recorded on Payments once the payout is posted.</div>}
                </>
              );
            })()}
            {peak && !peak.accountsConfigured && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.45 }}>No PEAK expense account is configured (PEAK_ACCT_EXPENSES), so no row can be mapped yet.</div>
            )}
            {/* The blocking reason is actionable right here. Shown whenever the
                mapping is missing, and reachable via "Change" once it is set. */}
            {peak && (contactEdit !== null || !peak.contactMapped) ? (
              <div className="js-contact-map">
                <label htmlFor="peakContact">PEAK Contact</label>
                {/* The guide already exists in PEAK, so pick them from the list.
                    Falls back to entering the id by hand if the list will not load,
                    so a PEAK outage never blocks the mapping. */}
                {peakContacts === null ? (
                  <div className="hint">Loading PEAK contacts…</div>
                ) : peakContacts.length ? (
                  <select id="peakContact" value={contactEdit ?? ""} onChange={(ev) => setContactEdit(ev.target.value)}>
                    <option value="">— not mapped —</option>
                    {peakContacts.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{c.taxNumber ? ` · ${c.taxNumber}` : ""}</option>
                    ))}
                  </select>
                ) : (
                  <input id="peakContact" value={contactEdit ?? ""} placeholder="PEAK contact id" autoComplete="off"
                    onChange={(ev) => setContactEdit(ev.target.value)}
                    onKeyDown={(ev) => { if (ev.key === "Enter") savePeakContact(contactEdit ?? ""); if (ev.key === "Escape") setContactEdit(null); }} />
                )}
                <div className="row" style={{ marginTop: 5 }}>
                  <button className="btn sm primary" disabled={busy} onClick={() => savePeakContact(contactEdit ?? "")}>Save</button>
                  {peak.contactMapped && <button className="btn sm ghost" disabled={busy} onClick={() => setContactEdit(null)}>Cancel</button>}
                </div>
                <div className="hint">
                  {contactsError
                    ? `${contactsError} Enter the id by hand, or retry once PEAK responds.`
                    : "The guide's existing supplier record in PEAK. Stored on their profile and reused by every job — never matched by name."}
                </div>
              </div>
            ) : peak?.contactMapped ? (
              <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-soft)" }}>
                Guide mapped to PEAK contact{header?.peakContactName ? ` · ${header.peakContactName}` : ""}{!header?.peakContactName && header?.peakContactId ? ` · ${header.peakContactId}` : ""}
                {canEdit && <button className="btn sm ghost" style={{ marginLeft: 6, padding: "1px 6px" }} onClick={() => setContactEdit(header?.peakContactId ?? "")}>Change</button>}
              </div>
            ) : null}
            {peak?.accountingDate && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-soft)" }}>Accounting date <b style={{ color: "var(--ink)" }}>{peak.accountingDate}</b>{peak.accountingDate === sheet.date ? " (tour date)" : ""}</div>
            )}
          </div>

          <a className="btn sm" href="/payments" style={{ display: "inline-block" }}>Open Payments</a>
        </aside>
      )}
      </div>
      )}
    </div>
  );
}
