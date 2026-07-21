import { prisma } from "@/lib/db";
import { linePush, lineEnabled } from "@/lib/line";
import { notifyGuide } from "@/lib/booking-import";
import { SLOT_TIMES } from "@/lib/slots";
import { computeTotals, expenseAmount, thb, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

const BASE = "https://guide.folkpaths.com";

export type PaymentRow = { when: string; tour: string; exp: number; fee: number; grand: number; hasSheet: boolean; reported: number | null };

// Build the LINE Flex "bubble" for a payment notice — a table with a row per tour
// (date · time · tour · expenses · fee · total) plus a totals row and two link
// buttons (bank slip + full details). Pure: returns the Flex `contents` object, so
// it's unit-tested directly. Colours are the Folkpaths brand (brown header + cream).
export function paymentFlex(p: {
  scope?: string;
  rows: PaymentRow[];
  total: number; totExp: number; totFee: number; count: number;
  slipUrl?: string; payUrl: string; period?: string; // period (YYYY-MM) enables the review buttons
}): object {
  const baht = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`;
  const BROWN = "#7E3A2C", CREAM = "#F6F1E6", MUTED = "#9B9B9B", INK = "#1A1A1A", SUB = "#6A6A6A";
  const colHead = { type: "box", layout: "horizontal", contents: [
    { type: "text", text: "Tour", size: "xs", color: MUTED, flex: 5 },
    { type: "text", text: "Exp.", size: "xs", color: MUTED, align: "end", flex: 2 },
    { type: "text", text: "Fee", size: "xs", color: MUTED, align: "end", flex: 2 },
    { type: "text", text: "Total", size: "xs", color: MUTED, align: "end", flex: 2 },
  ] };
  const AMBER = "#B26A00";
  const rowBoxes = p.rows.map((r) => {
    const left: object[] = [
      { type: "text", text: r.when, size: "sm", color: INK },
      { type: "text", text: r.tour, size: "xxs", color: MUTED, wrap: true },
    ];
    // Review line: the guide's own reported total vs what was reimbursed. Amber = differs.
    if (r.reported != null) {
      const match = Math.round(r.exp) === r.reported;
      left.push({ type: "text", text: match ? `you reported ${baht(r.reported)} ✓` : `you reported ${baht(r.reported)} — check`, size: "xxs", color: match ? MUTED : AMBER, wrap: true });
    }
    return { type: "box", layout: "horizontal", margin: "md", contents: [
      { type: "box", layout: "vertical", flex: 5, contents: left },
      { type: "text", text: r.hasSheet ? baht(r.exp) : "—", size: "sm", color: SUB, align: "end", flex: 2, gravity: "center" },
      { type: "text", text: r.hasSheet ? baht(r.fee) : "—", size: "sm", color: SUB, align: "end", flex: 2, gravity: "center" },
      { type: "text", text: baht(r.grand), size: "sm", weight: "bold", color: INK, align: "end", flex: 2, gravity: "center" },
    ] };
  });
  const totalRow = { type: "box", layout: "horizontal", margin: "md", contents: [
    { type: "text", text: "Total", size: "sm", weight: "bold", color: INK, flex: 5 },
    { type: "text", text: baht(p.totExp), size: "sm", weight: "bold", color: INK, align: "end", flex: 2 },
    { type: "text", text: baht(p.totFee), size: "sm", weight: "bold", color: INK, align: "end", flex: 2 },
    { type: "text", text: baht(p.total), size: "sm", weight: "bold", color: INK, align: "end", flex: 2 },
  ] };
  // Review buttons (only when a period is known): the guide taps one to confirm the
  // expenses look right, or flag them — handled by the LINE webhook (expreview:...).
  const GREEN = "#2E7D46";
  const reviewRow = p.period ? [{ type: "box", layout: "horizontal", spacing: "sm", contents: [
    { type: "button", style: "primary", color: GREEN, height: "sm", action: { type: "postback", label: "✓ Looks right", data: `expreview:ok:${p.period}`, displayText: "✓ Looks right" } },
    { type: "button", style: "primary", color: AMBER, height: "sm", action: { type: "postback", label: "⚠ Something's off", data: `expreview:off:${p.period}`, displayText: "⚠ Something's off" } },
  ] }] : [];
  const linkRow = { type: "box", layout: "horizontal", spacing: "sm", contents: [
    ...(p.slipUrl ? [{ type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "Bank slip", uri: p.slipUrl } }] : []),
    { type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "Full details", uri: p.payUrl } },
  ] };
  return {
    type: "bubble",
    header: { type: "box", layout: "vertical", backgroundColor: BROWN, paddingAll: "14px", spacing: "xs", contents: [
      { type: "text", text: `Payment${p.scope ? ` · ${p.scope}` : ""}`, size: "sm", color: CREAM },
      { type: "text", text: `${baht(p.total)}  ·  ${p.count} tour${p.count === 1 ? "" : "s"} paid`, size: "xl", weight: "bold", color: CREAM },
    ] },
    body: { type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm", contents: [
      colHead, { type: "separator", margin: "sm" }, ...rowBoxes, { type: "separator", margin: "md" }, totalRow,
    ] },
    footer: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px", contents: [...reviewRow, linkRow] },
  };
}

// One payment notification (LINE + in-app): a short summary plus the completed
// tours just paid (date · time · tour · amount). Shared by the monthly e-slip
// and the per-tour / merged-batch slip so both read identically.
export async function sendPaymentNotice(
  guideId: string,
  jobs: { date: string; slotIdx: number }[],
  scope?: string, // e.g. "June 2026" for a monthly slip; omit for a per-tour batch
  slipUrl?: string, // the uploaded bank slip, so the guide can open it straight from the alert
  period?: string, // YYYY-MM — when set, the LINE card gets the review buttons
): Promise<void> {
  if (!jobs.length) return;
  const where = { guideId, OR: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) };
  const [sheets, asgs] = await Promise.all([
    prisma.jobSheet.findMany({ where, select: { date: true, slotIdx: true, expenses: true, guideFee: true, guideExpenses: true } }),
    prisma.assignment.findMany({ where, include: { tour: true } }),
  ]);
  const sheetMap = new Map(sheets.map((s) => [`${s.date}|${s.slotIdx}`, s]));
  const tourName = (d: string, s: number) => asgs.find((a) => a.date === d && a.slotIdx === s)?.tour?.name ?? "Tour";
  const sorted = [...jobs].sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx);
  const baht = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`; // whole baht, no ".00" noise
  let total = 0, totExp = 0, totFee = 0;
  const rows: PaymentRow[] = sorted.map((j) => {
    const sh = sheetMap.get(`${j.date}|${j.slotIdx}`);
    const t = sh ? computeTotals((sh.expenses as Expense[]) ?? [], (sh.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE) : null;
    const exp = t?.totalExpenses ?? 0, fee = t?.netGuideFee ?? 0, grand = t?.grandTotal ?? 0;
    total += grand; totExp += exp; totFee += fee;
    // What the guide themselves reported spending (their own expense submission), so the
    // payment message doubles as a review: did the reimbursement match what they reported?
    const ge = Array.isArray(sh?.guideExpenses) ? (sh!.guideExpenses as Expense[]) : null;
    const reported = ge && ge.length ? Math.round(ge.reduce((s, e) => s + expenseAmount(e), 0)) : null;
    const dl = new Date(`${j.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    return { when: `${dl} · ${SLOT_TIMES[j.slotIdx] ?? ""}`, tour: tourName(j.date, j.slotIdx), exp, fee, grand, hasSheet: !!t, reported };
  });
  // A guide's reported total vs what was reimbursed — the review line (only when they
  // submitted their own expenses). Flags a mismatch so they can raise it.
  const reviewLine = (r: PaymentRow) => r.reported == null ? "" : `\nYou reported ${baht(r.reported)}${Math.round(r.exp) === r.reported ? " ✓ matches" : ` — reimbursed ${baht(r.exp)}, please check`}`;
  // Plain-text body — in-app bell / web push / email, and the LINE Flex fallback
  // (altText). A simple "expenses + fee = total" per tour + the review line.
  const lines = rows.map((r) => `✓ ${r.when} — ${r.tour}${r.hasSheet ? `\n${baht(r.exp)} expenses + ${baht(r.fee)} fee = ${baht(r.grand)}` : ""}${reviewLine(r)}`);
  const head = `💸 Your payment${scope ? ` for ${scope}` : ""} has been transferred${total > 0 ? ` — ${baht(total)}` : ""} for ${jobs.length} tour${jobs.length === 1 ? "" : "s"}. Thank you!`;
  const slipLine = slipUrl ? `\n\nBank slip: ${slipUrl}` : "";
  const sheetsLine = `\n\nYour tours & job sheets: ${BASE}/pay`;
  const textBody = `${head}\n\n${lines.join("\n\n")}${slipLine}${sheetsLine}`;
  // LINE gets the rich table (Flex); every other channel gets the text above.
  const flex = paymentFlex({ scope, rows, total, totExp, totFee, count: jobs.length, slipUrl, payUrl: `${BASE}/pay`, period });
  await notifyGuide(guideId, textBody, "Payment transferred 💸", `${scope ?? `${jobs.length} tour${jobs.length === 1 ? "" : "s"}`}${total > 0 ? ` · ${baht(total)}` : ""}`, { lineFlex: { altText: head, contents: flex } });
}

type SheetJob = {
  slotIdx: number; tourName: string; pax: number | null; note: string | null;
  totalExpenses?: number; netGuideFee?: number;
};

// One guide's "mini job sheet" for a date as a LINE-friendly text block.
function buildSheet(dateLabel: string, jobs: SheetJob[]) {
  const lines = jobs
    .sort((a, b) => a.slotIdx - b.slotIdx)
    .map((j) => {
      const time = SLOT_TIMES[j.slotIdx] ?? "";
      let s = `${time} • ${j.tourName}`;
      if (j.pax != null) s += `\nTotal: ${j.pax} Pax · 1 Job`;
      if (j.note) s += `\n${j.note}`;
      if (j.totalExpenses != null) s += `\nExpenses ${thb(j.totalExpenses)}`;
      if (j.netGuideFee != null) s += `\nNet guide fee ${thb(j.netGuideFee)}`;
      return s;
    });
  return `Folkpaths Job Sheet — ${dateLabel}\n${lines.join("\n\n")}\n${jobs.length} job(s)`;
}

// Send a date's job sheet(s) to the assigned guide(s) — in-app bell + LINE (when
// linked), with a job-order link per tour. Shared by the operator "send" action
// and the post-payment "for your reference" send. Returns delivery counts.
export async function sendJobSheetsForDate(
  date: string,
  guideId?: string,
): Promise<{ count: number; lineSent: number; lineSkipped: string[] }> {
  const assignments = await prisma.assignment.findMany({
    where: { date, ...(guideId ? { guideId } : {}) },
    include: { tour: true },
  });
  if (assignments.length === 0) return { count: 0, lineSent: 0, lineSkipped: [] };

  const sheets = await prisma.jobSheet.findMany({ where: { date, ...(guideId ? { guideId } : {}) } });
  const sheetBy = new Map(sheets.map((s) => [`${s.guideId}:${s.slotIdx}`, s]));

  const byGuide = new Map<string, SheetJob[]>();
  for (const a of assignments) {
    const arr = byGuide.get(a.guideId) ?? [];
    const s = sheetBy.get(`${a.guideId}:${a.slotIdx}`);
    const totals = s ? computeTotals(s.expenses as unknown as Expense[], s.guideFee as unknown as GuideFee) : null;
    arr.push({
      slotIdx: a.slotIdx, tourName: a.tour?.name ?? a.tourId, pax: a.pax, note: a.note,
      totalExpenses: totals?.totalExpenses, netGuideFee: totals?.netGuideFee,
    });
    byGuide.set(a.guideId, arr);
  }

  const guides = await prisma.user.findMany({
    where: { role: "GUIDE", guideId: { in: [...byGuide.keys()] } },
    select: { id: true, guideId: true, displayName: true, lineUserId: true },
  });
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  let lineSent = 0;
  const lineSkipped: string[] = [];
  for (const g of guides) {
    const jobs = byGuide.get(g.guideId!) ?? [];
    const base = buildSheet(dateLabel, jobs);
    // In-app keeps the tappable job-order links. LINE does NOT — a raw link makes
    // LINE render a preview card of the site; without a URL there's no card.
    const orderLinks = jobs.map((j) => `\n\nJob order ${SLOT_TIMES[j.slotIdx] ?? ""}:\n${BASE}/api/jobsheet/joborder?guideId=${g.guideId}&date=${date}&slotIdx=${j.slotIdx}`).join("");
    await prisma.notification.create({ data: { userId: g.id, kind: "jobsheet", message: base + orderLinks } });
    if (lineEnabled && g.lineUserId) { await linePush(g.lineUserId, `${base}\n\nOpen the Folkpaths app to view the job order.`); lineSent++; }
    else lineSkipped.push(g.guideId!);
  }
  return { count: guides.length, lineSent, lineSkipped };
}
