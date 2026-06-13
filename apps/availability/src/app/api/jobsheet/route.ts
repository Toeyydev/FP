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

  // Current bookings at this date + slot. By default ALL combine into one job; if
  // the slot was SPLIT across guides, this guide sees only the bookings tagged to
  // them (plus any untagged).
  const allAtSlot = await prisma.booking.findMany({
    where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
    select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true },
    orderBy: { createdAt: "asc" },
  });
  const splitHere = allAtSlot.some((b) => b.assignedGuideId);
  const linked = splitHere ? allAtSlot.filter((b) => !b.assignedGuideId || b.assignedGuideId === guideId) : allAtSlot;
  type SheetBooking = { name: string; bookingNo: string; bookedPax: number | null; actualPax: number | null; tickets: string; status: string };
  const liveBookings: SheetBooking[] = linked.map((b) => ({ name: b.customerName ?? "", bookingNo: b.externalRef || b.confirmationCode || "", bookedPax: b.pax ?? null, actualPax: b.pax ?? null, tickets: "", status: "" }));
  const keyOf = (b: { bookingNo?: string; name?: string }) => (b.bookingNo || b.name || "").trim().toLowerCase();

  // Saved sheet: keep it live. Surface any booking that arrived AFTER it was saved
  // (e.g. a late add), so the assigned job always reflects the real guest list —
  // while keeping the operator's edits to the rows already on the sheet.
  if (existing) {
    // A past tour is a finished record: never auto-add or drop its bookings, so the
    // operator's curated sheet stays exactly as saved. Only upcoming/today sheets get
    // reconciled against live bookings (to surface late adds / re-slots).
    const todayBKK = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    if (date < todayBKK) {
      return NextResponse.json({ header, tour, saved: true, canEdit: isOps, sheet: existing, reconciledAdded: 0, reconciledRemoved: 0 });
    }
    const saved = (Array.isArray(existing.bookings) ? existing.bookings : []) as SheetBooking[];
    const liveKeys = new Set(liveBookings.map(keyOf).filter(Boolean));
    // A saved row is removed ONLY if its booking was genuinely RE-SLOTTED — i.e. it
    // is now active at a DIFFERENT slot on this date (that caused the same guest to
    // appear on both the 08:30 and 13:30 sheets). Bookings that are simply no longer
    // "active" (past / completed tours) are KEPT, so editing a past job sheet never
    // loses its rows. Manual rows (no booking number) are always kept.
    const elsewhere = await prisma.booking.findMany({
      where: { date, slotIdx: { not: slotIdx }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      select: { customerName: true, externalRef: true, confirmationCode: true },
    });
    const movedKeys = new Set(elsewhere.map((b) => keyOf({ bookingNo: b.externalRef || b.confirmationCode || "", name: b.customerName || "" })).filter(Boolean));
    const kept = saved.filter((b) => {
      if (!((b.bookingNo || "").trim())) return true;     // manual row — always keep
      const k = keyOf(b);
      if (liveKeys.has(k)) return true;                    // still active at this slot
      return !movedKeys.has(k);                            // drop only if re-slotted elsewhere
    });
    const have = new Set(kept.map(keyOf).filter(Boolean));
    const added = liveBookings.filter((b) => { const k = keyOf(b); return k && !have.has(k); });
    const changed = added.length > 0 || kept.length !== saved.length;
    const sheet = changed ? { ...existing, bookings: kept.concat(added) } : existing;
    return NextResponse.json({ header, tour, saved: true, canEdit: isOps, sheet, reconciledAdded: added.length, reconciledRemoved: saved.length - kept.length });
  }

  // No saved sheet yet — scaffold from the current bookings.
  const bookings = liveBookings.length
    ? liveBookings
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

// Numeric fields are .nullish() (null OR undefined -> null): imported/edge sheets can
// store gaps, and JSON.stringify drops undefined keys on re-save, so requiring a
// present number would reject an otherwise-valid save. Strings/extra keys are lenient.
const num = z.number().nullish().transform((v) => v ?? null);
const bookingZ = z.object({ name: z.string().max(200).optional().default(""), bookingNo: z.string().max(120).optional().default(""), bookedPax: num, actualPax: num, tickets: z.string().max(20).optional().default(""), status: z.string().max(40).optional().default("") });
const expenseZ = z.object({ description: z.string().max(160).optional().default(""), price: num, pax: num });
const guideFeeZ = z.object({ price: num, time: num, whtPct: num }).nullish().transform((v) => v ?? { price: null, time: null, whtPct: null });

// PUT — operator only. Upserts the sheet; assigns a FOLK-BKK-… ref on first save.
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
    tourId: z.string().default(""), status: z.string().max(40).default("Confirmed"),
    bookings: z.array(bookingZ).max(20), expenses: z.array(expenseZ).max(40), guideFee: guideFeeZ,
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", detail: parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` : undefined }, { status: 400 });
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
  const BASE = "https://guide.folkpaths.com";
  for (const g of guides) {
    const jobs = byGuide.get(g.guideId!) ?? [];
    // Include a link to each tour's job order so the guide can open/print it.
    const orderLinks = jobs.map((j) => `\n\nJob order ${SLOT_TIMES[j.slotIdx] ?? ""}:\n${BASE}/api/jobsheet/joborder?guideId=${g.guideId}&date=${date}&slotIdx=${j.slotIdx}`).join("");
    const text = buildSheet(dateLabel, jobs) + orderLinks;
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
