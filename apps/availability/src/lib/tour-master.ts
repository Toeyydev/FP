import { prisma } from "@/lib/db";

// The display name for a tour is the TourMaster real product title (via
// Tour.tourCode → an ACTIVE tour_master row), falling back to the internal
// Tour.name when the tour isn't linked or the master row is missing/inactive.
// Centralised here so every surface (board, sheet, PDF, exports, offers,
// payments) resolves the title identically. See the TourMaster model.

// List surfaces: tourId → display name. Pass tourIds to scope the query; omit
// for the whole catalogue.
export async function tourNameMap(tourIds?: string[]): Promise<Map<string, string>> {
  const [tours, masters] = await Promise.all([
    prisma.tour.findMany({ where: tourIds ? { id: { in: tourIds } } : undefined, select: { id: true, name: true, tourCode: true } }),
    prisma.tourMaster.findMany({ where: { isActive: true }, select: { tourCode: true, tourName: true } }),
  ]);
  const byCode = new Map(masters.map((m) => [m.tourCode, m.tourName]));
  return new Map(tours.map((t) => [t.id, (t.tourCode && byCode.get(t.tourCode)) || t.name]));
}

// Single-tour surfaces: the master title for a tourCode, or null to fall back.
export async function masterTitle(tourCode?: string | null): Promise<string | null> {
  if (!tourCode) return null;
  const m = await prisma.tourMaster.findUnique({ where: { tourCode }, select: { tourName: true, isActive: true } });
  return m?.isActive && m.tourName ? m.tourName : null;
}
