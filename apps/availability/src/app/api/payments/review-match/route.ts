import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { productKey } from "@/lib/bookings";
import { matchTourByProduct } from "@/lib/product-match";
import { SLOT_TIMES } from "@/lib/slots";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

type Candidate = { date: string; slotIdx: number; time: string; tourId: string; tour: string; guideId: string; guide: string; customerName: string | null; ref: string | null };

// GET ?date&name&product&tourId — find which guide ran a tour, so an operator can
// reward a 5★ OTA review. The review email gives only the product; the operator adds
// the tour date and/or the reviewer's name (read from the OTA portal) and this maps
// product→tour (ProductMap), then the date/name→the assigned guide. Finance-gated.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const date = DATE.test(sp.get("date") || "") ? sp.get("date")! : "";
  const name = (sp.get("name") || "").trim();
  const product = (sp.get("product") || "").trim();
  if (!date && name.length < 2) return NextResponse.json({ error: "need-date-or-name", candidates: [] }, { status: 400 });

  // Resolve the product name to one of our tours (best-effort; empty = no tour filter).
  // Exact ProductMap key first; then a fuzzy token match, because OTA review emails use
  // different title strings than the bookings/ProductMap (verified against production).
  let tourId = sp.get("tourId") || "";
  if (!tourId && product) {
    const exact = await prisma.productMap.findUnique({ where: { productKey: productKey(product) } }).catch(() => null);
    if (exact) tourId = exact.tourId;
    else {
      const [maps, bk] = await Promise.all([
        prisma.productMap.findMany({ select: { productName: true, tourId: true } }),
        prisma.booking.findMany({ where: { productName: { not: null }, tourId: { not: null } }, select: { productName: true, tourId: true }, distinct: ["productName"], take: 200 }),
      ]);
      const candidates = [
        ...maps.map((m) => ({ name: m.productName, tourId: m.tourId })),
        ...bk.map((b) => ({ name: b.productName as string, tourId: b.tourId as string })),
      ];
      tourId = matchTourByProduct(product, candidates) ?? "";
    }
  }

  // Search window: the exact date, else the last ~90 days (reviews lag the tour).
  const from = date || bkk(-90), to = date || bkk(0);

  const [tours, guides, assigns] = await Promise.all([
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.assignment.findMany({ where: { date: { gte: from, lte: to }, ...(tourId ? { tourId } : {}) }, select: { guideId: true, date: true, slotIdx: true, tourId: true } }),
  ]);
  const tName = (id: string) => tours.find((t) => t.id === id)?.name ?? id;
  const gName = (id: string) => guides.find((g) => g.guideId === id)?.displayName ?? id;
  const slotGuides = new Map<string, { guideId: string; tourId: string }[]>();
  for (const a of assigns) { const k = `${a.date}|${a.slotIdx}`; (slotGuides.get(k) ?? slotGuides.set(k, []).get(k)!).push({ guideId: a.guideId, tourId: a.tourId }); }

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const push = (date: string, slotIdx: number, tId: string, guideId: string, customerName: string | null, ref: string | null) => {
    const k = `${date}|${slotIdx}|${guideId}`;
    if (seen.has(k)) return; seen.add(k);
    candidates.push({ date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "", tourId: tId, tour: tName(tId), guideId, guide: gName(guideId), customerName, ref });
  };

  if (name.length >= 2) {
    // Reviewer name → the booking they made → that departure's guide.
    const bookings = await prisma.booking.findMany({
      where: { date: { gte: from, lte: to }, customerName: { contains: name, mode: "insensitive" }, status: { notIn: ["CANCELLED", "IGNORED"] }, ...(tourId ? { tourId } : {}) },
      select: { date: true, slotIdx: true, tourId: true, customerName: true, externalRef: true, confirmationCode: true, assignedGuideId: true },
      take: 50,
    });
    for (const b of bookings) {
      if (!b.date || b.slotIdx == null) continue;
      const ref = b.externalRef || b.confirmationCode || null;
      const gs = b.assignedGuideId ? [{ guideId: b.assignedGuideId, tourId: b.tourId ?? "" }] : (slotGuides.get(`${b.date}|${b.slotIdx}`) ?? []);
      for (const g of gs) push(b.date, b.slotIdx, g.tourId || b.tourId || "", g.guideId, b.customerName ?? null, ref);
    }
  } else {
    // Date only → every guide who ran a (matching) tour that day.
    for (const [k, gs] of slotGuides) {
      const [d, slot] = k.split("|");
      for (const g of gs) push(d, Number(slot), g.tourId, g.guideId, null, null);
    }
  }

  candidates.sort((a, b) => b.date.localeCompare(a.date) || a.slotIdx - b.slotIdx);
  return NextResponse.json({ tourId: tourId || null, candidates: candidates.slice(0, 25) });
}
