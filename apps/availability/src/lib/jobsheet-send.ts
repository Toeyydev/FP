import { prisma } from "@/lib/db";
import { linePush, lineEnabled } from "@/lib/line";
import { notifyGuide } from "@/lib/booking-import";
import { SLOT_TIMES } from "@/lib/slots";
import { computeTotals, thb, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

const BASE = "https://guide.folkpaths.com";

// One payment notification (LINE + in-app): a short summary plus the completed
// tours just paid (date · time · tour · amount). Shared by the monthly e-slip
// and the per-tour / merged-batch slip so both read identically.
export async function sendPaymentNotice(
  guideId: string,
  jobs: { date: string; slotIdx: number }[],
  scope?: string, // e.g. "June 2026" for a monthly slip; omit for a per-tour batch
  slipUrl?: string, // the uploaded bank slip, so the guide can open it straight from the alert
): Promise<void> {
  if (!jobs.length) return;
  const where = { guideId, OR: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) };
  const [sheets, asgs] = await Promise.all([
    prisma.jobSheet.findMany({ where, select: { date: true, slotIdx: true, expenses: true, guideFee: true } }),
    prisma.assignment.findMany({ where, include: { tour: true } }),
  ]);
  const sheetMap = new Map(sheets.map((s) => [`${s.date}|${s.slotIdx}`, s]));
  const tourName = (d: string, s: number) => asgs.find((a) => a.date === d && a.slotIdx === s)?.tour?.name ?? "Tour";
  const sorted = [...jobs].sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx);
  const baht = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`; // whole baht, no ".00" noise
  let total = 0;
  const lines = sorted.map((j) => {
    const sh = sheetMap.get(`${j.date}|${j.slotIdx}`);
    const t = sh ? computeTotals((sh.expenses as Expense[]) ?? [], (sh.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE) : null;
    total += t?.grandTotal ?? 0;
    const dl = new Date(`${j.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    // Header line + a simple "expenses + fee = total" breakdown (whole baht) so the
    // guide sees what makes up the payment right in LINE — no need to open the app.
    // Full itemisation stays one tap away via the /pay link below.
    let s = `✓ ${dl} · ${SLOT_TIMES[j.slotIdx] ?? ""} — ${tourName(j.date, j.slotIdx)}`;
    if (t) s += `\n${baht(t.totalExpenses)} expenses + ${baht(t.netGuideFee)} fee = ${baht(t.grandTotal)}`;
    return s;
  });
  const head = `💸 Your payment${scope ? ` for ${scope}` : ""} has been transferred${total > 0 ? ` — ${baht(total)}` : ""} for ${jobs.length} tour${jobs.length === 1 ? "" : "s"}. Thank you!`;
  const slipLine = slipUrl ? `\n\nBank slip: ${slipUrl}` : "";
  // Deep-link to the guide's pay page, where every paid tour now opens its job sheet
  // — so right after the slip lands the guide can check each previous job sheet.
  const sheetsLine = `\n\nYour tours & job sheets: ${BASE}/pay`;
  await notifyGuide(guideId, `${head}\n\n${lines.join("\n\n")}${slipLine}${sheetsLine}`, "Payment transferred 💸", `${scope ?? `${jobs.length} tour${jobs.length === 1 ? "" : "s"}`}${total > 0 ? ` · ${baht(total)}` : ""}`);
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
