import { prisma } from "@/lib/db";
import { parseBokun, isCancellation, productKey, detectChannel } from "@/lib/bookings";

export type ImportResult = "created" | "updated" | "skipped";

// Parse one raw Bokun/channel payload and upsert it into Booking. Used by BOTH the
// live webhook and the historical sync. Dedupes by (source, externalId); when no
// externalId is present, falls back to confirmationCode so re-syncing won't create
// duplicates. Auto-maps the tour from a learned product→tour mapping.
export async function importRawBooking(raw: unknown): Promise<ImportResult> {
  const p = parseBokun(raw);
  const cancelled = isCancellation(raw);
  const channel = detectChannel(raw);

  let tourId: string | null = null;
  if (p.productName) {
    const map = await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null);
    if (map) tourId = map.tourId;
  }

  if (p.externalId) {
    const existing = await prisma.booking.findUnique({ where: { source_externalId: { source: channel, externalId: p.externalId } }, select: { id: true } });
    await prisma.booking.upsert({
      where: { source_externalId: { source: channel, externalId: p.externalId } },
      create: {
        source: channel, externalId: p.externalId, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null,
        productName: p.productName ?? null, tourId, date: p.date ?? null, startTime: p.startTime ?? null,
        slotIdx: p.slotIdx ?? null, pax: p.pax ?? null, customerName: p.customerName ?? null,
        status: cancelled ? "CANCELLED" : "PENDING", raw: raw as object,
      },
      update: {
        confirmationCode: p.confirmationCode ?? undefined, externalRef: p.externalRef ?? undefined, productName: p.productName ?? undefined,
        tourId: tourId ?? undefined, date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined,
        pax: p.pax ?? undefined, customerName: p.customerName ?? undefined,
        status: cancelled ? "CANCELLED" : undefined, raw: raw as object,
      },
    });
    return existing ? "updated" : "created";
  }

  // No externalId: dedupe on confirmationCode so a re-sync doesn't duplicate.
  if (p.confirmationCode) {
    const dup = await prisma.booking.findFirst({ where: { confirmationCode: p.confirmationCode }, select: { id: true } });
    if (dup) return "skipped";
  }
  await prisma.booking.create({
    data: {
      source: channel, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null, productName: p.productName ?? null, tourId,
      date: p.date ?? null, startTime: p.startTime ?? null, slotIdx: p.slotIdx ?? null,
      pax: p.pax ?? null, customerName: p.customerName ?? null, status: cancelled ? "CANCELLED" : "PENDING", raw: raw as object,
    },
  });
  return "created";
}
