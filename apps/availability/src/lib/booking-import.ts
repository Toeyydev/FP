import { prisma } from "@/lib/db";
import { parseBokun, isCancellation, productKey, detectChannel, type ParsedBooking } from "@/lib/bookings";

export type ImportResult = "created" | "updated" | "skipped";

// Upsert one already-parsed booking. Dedupes by (source, externalId); when no
// externalId, falls back to confirmationCode so re-imports don't duplicate.
// Auto-maps the tour from a learned product→tour mapping. Shared by the webhook,
// the Bokun API sync, and the CSV import.
export async function importParsed(p: ParsedBooking, opts: { source: string; cancelled: boolean; raw?: unknown }): Promise<ImportResult> {
  let tourId: string | null = null;
  if (p.productName) {
    const map = await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null);
    if (map) tourId = map.tourId;
  }
  const { source, cancelled } = opts;
  const raw = (opts.raw ?? undefined) as object | undefined;

  if (p.externalId) {
    const existing = await prisma.booking.findUnique({ where: { source_externalId: { source, externalId: p.externalId } }, select: { id: true } });
    await prisma.booking.upsert({
      where: { source_externalId: { source, externalId: p.externalId } },
      create: {
        source, externalId: p.externalId, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null,
        productName: p.productName ?? null, tourId, date: p.date ?? null, startTime: p.startTime ?? null,
        slotIdx: p.slotIdx ?? null, pax: p.pax ?? null, customerName: p.customerName ?? null,
        status: cancelled ? "CANCELLED" : "PENDING", raw,
      },
      update: {
        confirmationCode: p.confirmationCode ?? undefined, externalRef: p.externalRef ?? undefined, productName: p.productName ?? undefined,
        tourId: tourId ?? undefined, date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined,
        pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, status: cancelled ? "CANCELLED" : undefined, raw,
      },
    });
    return existing ? "updated" : "created";
  }

  // No externalId: dedupe on confirmationCode / externalRef so re-import is safe.
  const ref = p.confirmationCode || p.externalRef;
  if (ref) {
    const dup = await prisma.booking.findFirst({ where: { OR: [{ confirmationCode: ref }, { externalRef: ref }] }, select: { id: true } });
    if (dup) {
      await prisma.booking.update({ where: { id: dup.id }, data: { tourId: tourId ?? undefined, date: p.date ?? undefined, slotIdx: p.slotIdx ?? undefined, pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, productName: p.productName ?? undefined, status: cancelled ? "CANCELLED" : undefined } });
      return "updated";
    }
  }
  await prisma.booking.create({
    data: {
      source, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null, productName: p.productName ?? null, tourId,
      date: p.date ?? null, startTime: p.startTime ?? null, slotIdx: p.slotIdx ?? null,
      pax: p.pax ?? null, customerName: p.customerName ?? null, status: cancelled ? "CANCELLED" : "PENDING",
    },
  });
  return "created";
}

// Import a raw Bokun/channel webhook payload (deep-parsed).
export async function importRawBooking(raw: unknown): Promise<ImportResult> {
  return importParsed(parseBokun(raw), { source: detectChannel(raw), cancelled: isCancellation(raw), raw });
}
