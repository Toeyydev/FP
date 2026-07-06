import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { parseJobSheetXlsx } from "@/lib/jobsheet-xlsx";
import { nextJobRef } from "@/lib/jobref";
import { encrypt } from "@/lib/crypto";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// Significant name tokens (drop titles + punctuation) for matching a sheet's guide
// name against the platform record — used to catch Guide-ID collisions on import.
function nameTokens(s: string | null | undefined): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/\b(miss|mrs|mr|ms|khun|k|dr)\.?\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// POST (multipart, one or more `file`) — import filled FOLKPATHS job-sheet .xlsx
// files. Each becomes a booking(s) + assignment + job sheet so non-Bokun tours
// land in the system without retyping. Operator/admin only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  type Up = { name?: string; arrayBuffer?: () => Promise<ArrayBuffer> };
  const files = ((form?.getAll("file") ?? []) as unknown[]).filter((f) => !!f && typeof (f as Up).arrayBuffer === "function") as Up[];
  if (!files.length) return NextResponse.json({ error: "no-file", hint: "Pick one or more .xlsx job sheets." }, { status: 400 });

  const results: { file: string; ok: boolean; detail: string; guideId?: string; date?: string; slotIdx?: number; ref?: string }[] = [];
  for (const file of files) {
    try {
      const fname = file.name || "file";
      if (!/\.xlsx$/i.test(fname)) { results.push({ file: fname, ok: false, detail: "Not an .xlsx — re-save as Excel Workbook (.xlsx)." }); continue; }
      const p = await parseJobSheetXlsx(await file.arrayBuffer!());
      if (!p.tourId || !p.guideId || !p.date || p.slotIdx == null) {
        results.push({ file: fname, ok: false, detail: `Missing key fields (tour=${p.tourId || "?"}, guide=${p.guideId || "?"}, date=${p.date || "?"}, time=${p.slotIdx ?? "?"}).` });
        continue;
      }
      let [tour, guide] = await Promise.all([
        prisma.tour.findUnique({ where: { id: p.tourId }, select: { id: true, name: true } }),
        prisma.user.findFirst({ where: { guideId: p.guideId }, select: { id: true, guideId: true, displayName: true, fullName: true, phone: true, taxId: true, currentAddress: true } }),
      ]);
      // Guard against a GuideMaster ID collision: if this Guide ID already belongs to a
      // clearly DIFFERENT-named guide on the platform, skip rather than attach the tour
      // to the wrong person (a re-import would otherwise create a duplicate sheet).
      if (guide && p.guideName?.trim()) {
        const want = nameTokens(p.guideName);
        const have = new Set([...nameTokens(guide.fullName), ...nameTokens(guide.displayName)]);
        if (want.length && have.size && !want.some((w) => have.has(w))) {
          results.push({ file: fname, ok: false, detail: `Guide ID ${p.guideId} is "${guide.displayName || guide.fullName || p.guideId}" here, but the sheet says "${p.guideName.trim()}". Skipped — set the file's Guide ID to this guide's platform ID.` });
          continue;
        }
      }
      const created: string[] = [];
      // Auto-create a missing tour / guide so a backlog of past tours imports without
      // hand-setup. Both are placeholders the operator can flesh out later; the guide
      // is an INVITED account (no login) that the real guide can claim by guideId.
      if (!tour) {
        tour = await prisma.tour.create({ data: { id: p.tourId, name: p.tourId, time: SLOT_TIMES[p.slotIdx] ?? "09:00" }, select: { id: true, name: true } });
        created.push(`tour ${p.tourId}`);
      }
      if (!guide) {
        const email = `imported-${p.guideId.toLowerCase()}@folkpaths.invalid`;
        const u = await prisma.user.create({ data: {
          email, guideId: p.guideId, role: "GUIDE", state: "INVITED",
          displayName: p.guideName?.trim() || p.guideId,
          fullName: p.guideName?.trim() || null,
          phone: p.tel || null,
          taxId: p.taxId ? encrypt(p.taxId) : null,
          currentAddress: p.address ? encrypt(p.address) : null,
        }, select: { id: true, guideId: true, displayName: true, fullName: true, phone: true, taxId: true, currentAddress: true } });
        guide = u;
        created.push(`guide ${p.guideId}`);
      }

      // Fill the guide's profile from the sheet — ONLY empty fields, so a guide's
      // own completed details are never overwritten. Tax ID / address are PII (encrypted).
      const gUpd: Record<string, string> = {};
      if (!guide.fullName && p.guideName) gUpd.fullName = p.guideName;
      if (!guide.phone && p.tel) gUpd.phone = p.tel;
      if (!guide.taxId && p.taxId) gUpd.taxId = encrypt(p.taxId);
      if (!guide.currentAddress && p.address) gUpd.currentAddress = encrypt(p.address);
      if (Object.keys(gUpd).length) await prisma.user.update({ where: { id: guide.id }, data: gUpd });

      const date = p.date, slotIdx = p.slotIdx, guideId = p.guideId, tourId = p.tourId;
      const totalPax = p.bookings.reduce((s, b) => s + (b.bookedPax ?? 0), 0) || null;

      // bookings (dedupe by booking no. so re-import / later Bokun sync won't duplicate)
      for (const b of p.bookings) {
        const base = { source: "manual", productName: tour.name, tourId, date, startTime: SLOT_TIMES[slotIdx], slotIdx, pax: b.bookedPax ?? null, customerName: b.name || null, status: "OFFERED" as const };
        const existing = b.bookingNo ? await prisma.booking.findFirst({ where: { OR: [{ confirmationCode: b.bookingNo }, { externalRef: b.bookingNo }] }, select: { id: true, status: true } }) : null;
        if (existing) {
          await prisma.booking.update({ where: { id: existing.id }, data: { tourId, date, slotIdx, pax: b.bookedPax ?? undefined, customerName: b.name || undefined, status: existing.status === "CANCELLED" ? undefined : "OFFERED" } });
        } else {
          await prisma.booking.create({ data: { ...base, confirmationCode: b.bookingNo || null, externalRef: b.bookingNo || null } });
        }
      }

      // assignment
      await prisma.assignment.upsert({
        where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
        create: { guideId, date, slotIdx, tourId, pax: totalPax },
        update: { tourId, pax: totalPax ?? undefined },
      });

      // job sheet
      const ref = p.ref || (await nextJobRef(date));
      const sheetBookings = p.bookings.map((b) => ({ ...b, status: "" })); // save schema requires a status field
      const guideFee = { price: p.guideFee.price ?? 1000, time: p.guideFee.time ?? 1, whtPct: p.guideFee.whtPct ?? 3 };
      await prisma.jobSheet.upsert({
        where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
        create: { guideId, date, slotIdx, tourId, ref, status: p.status || "Confirmed", bookings: sheetBookings, expenses: p.expenses, guideFee, createdById: session!.user!.id ?? null },
        update: { tourId, ref, status: p.status || "Confirmed", bookings: sheetBookings, expenses: p.expenses, guideFee },
      });

      await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.imported", entityType: "JobSheet", detail: { guideId, date, slotIdx, tourId, ref, bookings: p.bookings.length } });
      const parsedGuide = [p.guideName && "name", p.taxId && "tax", p.address && "addr", p.tel && "tel"].filter(Boolean).join("+") || "none-found";
      results.push({ file: fname, ok: true, guideId, date, slotIdx, ref, detail: `${tourId} · ${guideId} · ${date} ${SLOT_TIMES[slotIdx]} · ${p.bookings.length} booking(s) · ref ${ref}${created.length ? ` · created ${created.join(" + ")}` : ""} · guide-parsed:[${parsedGuide}]` });
    } catch (e) {
      results.push({ file: file.name || "file", ok: false, detail: (e as Error).message.slice(0, 160) });
    }
  }
  const imported = results.filter((r) => r.ok).length;
  return NextResponse.json({ ok: true, imported, failed: results.length - imported, results });
}
