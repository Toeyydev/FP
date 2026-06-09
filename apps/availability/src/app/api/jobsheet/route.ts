import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { linePush, lineEnabled } from "@/lib/line";
import { SLOT_TIMES } from "@/lib/slots";
import { decrypt } from "@/lib/crypto";
import { DEFAULT_EXPENSES, DEFAULT_GUIDE_FEE, makeRef, computeTotals, thb, type Expense, type GuideFee } from "@/lib/jobsheet";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

type SheetJob = {
  slotIdx: number; tourName: string; pax: number | null; note: string | null;
  totalExpenses?: number; netGuideFee?: number;
};
// Build one guide's "mini job sheet" for a date as a LINE-friendly text block.
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

// Header fields auto-pulled from the guide's profile (operator is authorized to see PII).
async function guideHeader(guideId: string) {
  const u = await prisma.user.findUnique({ where: { guideId } });
  if (!u) return null;
  return {
    guideId: u.guideId, name: u.fullName || u.displayName, email: u.email,
    tel: u.phone || "", taxId: decrypt(u.taxId), address: decrypt(u.currentAddress) || decrypt(u.idCardAddress),
  };
}

// GET ?guideId&date&slotIdx — operator only. Returns the saved sheet, or a
// default scaffold (preset expenses + standard guide fee) if none exists yet.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  // Operators/admin edit any sheet; a guide may only VIEW their own.
  const isOps = ops(session.user.role);
  if (!isOps && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [header, existing, assignment] = await Promise.all([
    guideHeader(guideId),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
  ]);
  const tourId = existing?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  if (existing) return NextResponse.json({ header, tour, saved: true, canEdit: isOps, sheet: existing });

  // No saved sheet yet — scaffold it from the bookings at this date + slot. By
  // default ALL of them combine into one job; but if the slot was SPLIT across
  // guides, this guide sees only the bookings tagged to them (plus any untagged).
  const allAtSlot = await prisma.booking.findMany({
    where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
    select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true },
    orderBy: { createdAt: "asc" },
  });
  const splitHere = allAtSlot.some((b) => b.assignedGuideId);
  const linked = splitHere ? allAtSlot.filter((b) => !b.assignedGuideId || b.assignedGuideId === guideId) : allAtSlot;
  const bookings = linked.length
    ? linked.map((b) => ({ name: b.customerName ?? "", bookingNo: b.externalRef || b.confirmationCode || "", bookedPax: b.pax ?? null, actualPax: b.pax ?? null, tickets: "", status: "" }))
    : [{ name: "", bookingNo: "", bookedPax: assignment?.pax ?? null, actualPax: assignment?.pax ?? null, tickets: "", status: "" }];

  // Pre-fill expense pax from the ACTUAL booked guests so reimbursements reflect
  // reality the moment the guide is assigned. "(Inc. Guide)" items add +1 (guide).
  const clientPax = linked.reduce((s, b) => s + (b.pax ?? 0), 0) || (assignment?.pax ?? 0);
  const expenses = clientPax > 0
    ? DEFAULT_EXPENSES.map((e) => ({ ...e, pax: /inc\.?\s*guide/i.test(e.description) ? clientPax + 1 : clientPax }))
    : DEFAULT_EXPENSES;

  return NextResponse.json({
    header, tour, saved: false, canEdit: isOps,
    sheet: { ref: null, guideId, date, slotIdx, tourId, status: "Confirmed", bookings, expenses, guideFee: DEFAULT_GUIDE_FEE, updatedAt: null },
  });
}

const bookingZ = z.object({ name: z.string().max(160), bookingNo: z.string().max(80), bookedPax: z.number().nullable(), actualPax: z.number().nullable(), tickets: z.string().max(20), status: z.string().max(40) });
const expenseZ = z.object({ description: z.string().max(120), price: z.number().nullable(), pax: z.number().nullable() });
const guideFeeZ = z.object({ price: z.number().nullable(), time: z.number().nullable(), whtPct: z.number().nullable() });

// PUT — operator only. Upserts the sheet; assigns a FOLK-BKK-… ref on first save.
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
    tourId: z.string().min(1), status: z.string().max(40).default("Confirmed"),
    bookings: z.array(bookingZ).max(20), expenses: z.array(expenseZ).max(40), guideFee: guideFeeZ,
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  const key = { guideId_date_slotIdx: { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx } };

  const existing = await prisma.jobSheet.findUnique({ where: key });
  let ref = existing?.ref ?? null;
  if (!ref) ref = makeRef(d.date, (await prisma.jobSheet.count({ where: { date: d.date } })) + 1);

  const sheet = await prisma.jobSheet.upsert({
    where: key,
    create: { ref, guideId: d.guideId, date: d.date, slotIdx: d.slotIdx, tourId: d.tourId, status: d.status, bookings: d.bookings, expenses: d.expenses, guideFee: d.guideFee, createdById: session!.user!.id ?? null },
    update: { tourId: d.tourId, status: d.status, bookings: d.bookings, expenses: d.expenses, guideFee: d.guideFee },
  });
  // Keep the assignment's pax in sync with the job sheet's booking total, so the
  // dispatch board ("On-going tours") and the LINE job sheet match the Job Details.
  const paxTotal = d.bookings.reduce((s, b) => s + (b.bookedPax ?? 0), 0);
  if (paxTotal > 0) {
    await prisma.assignment.updateMany({ where: { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx }, data: { pax: paxTotal } });
  }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.saved", entityType: "JobSheet", entityId: sheet.id, detail: { ref } });
  return NextResponse.json({ ok: true, sheet });
}

// POST { date: "YYYY-MM-DD", guideId? }  — operator/admin only.
// Sends each assigned guide their personal job sheet for the day via LINE (if
// linked) and as an in-app notification (always, so nothing is missed).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    guideId: z.string().min(1).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, guideId } = parsed.data;

  const assignments = await prisma.assignment.findMany({
    where: { date, ...(guideId ? { guideId } : {}) },
    include: { tour: true },
  });
  if (assignments.length === 0) return NextResponse.json({ ok: true, count: 0, lineSent: 0, lineSkipped: [] });

  // Saved job sheets for the day → so the guide also sees expenses + net fee.
  const sheets = await prisma.jobSheet.findMany({ where: { date, ...(guideId ? { guideId } : {}) } });
  const sheetBy = new Map(sheets.map((s) => [`${s.guideId}:${s.slotIdx}`, s]));

  // Group jobs per guide.
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
    const text = buildSheet(dateLabel, jobs);
    // Always drop it in the in-app bell.
    await prisma.notification.create({ data: { userId: g.id, kind: "jobsheet", message: text } });
    // Push to LINE if the guide has linked their account.
    if (lineEnabled && g.lineUserId) {
      await linePush(g.lineUserId, text);
      lineSent++;
    } else {
      lineSkipped.push(g.guideId!);
    }
  }

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "jobsheet.sent", entityType: "Assignment",
    detail: { date, guides: guides.length, lineSent, lineSkipped },
  });

  return NextResponse.json({ ok: true, count: guides.length, lineSent, lineSkipped });
}
