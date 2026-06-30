import { prisma } from "@/lib/db";
import { linePush, lineEnabled } from "@/lib/line";
import { SLOT_TIMES } from "@/lib/slots";
import { computeTotals, thb, type Expense, type GuideFee } from "@/lib/jobsheet";

const BASE = "https://guide.folkpaths.com";

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
    const orderLinks = jobs.map((j) => `\n\nJob order ${SLOT_TIMES[j.slotIdx] ?? ""}:\n${BASE}/api/jobsheet/joborder?guideId=${g.guideId}&date=${date}&slotIdx=${j.slotIdx}`).join("");
    const text = buildSheet(dateLabel, jobs) + orderLinks;
    await prisma.notification.create({ data: { userId: g.id, kind: "jobsheet", message: text } });
    if (lineEnabled && g.lineUserId) { await linePush(g.lineUserId, text); lineSent++; }
    else lineSkipped.push(g.guideId!);
  }
  return { count: guides.length, lineSent, lineSkipped };
}
