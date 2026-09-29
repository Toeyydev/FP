import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { linkExistingPeakDocument, previewLink, type LinkRequest } from "@/lib/advances/peak-link";

export const dynamic = "force-dynamic";

// POST — record that a movement is ALREADY in PEAK, under a document someone else
// created. Never posts to PEAK; the only outward call this can make is a read.
//
// Admin only. Everyone who can work the advances screen can record money; deciding
// that a document in the accountant's books IS this movement is a different act, and
// a wrong answer here hides a double entry rather than creating a visible one.
const allocation = z.object({ advanceId: z.string().min(1), amount: z.number().finite().positive() });
const body = z.object({
  kind: z.enum(["ADVANCE", "RETURN", "EXPENSE"]),
  documentNo: z.string().min(2).max(60),
  documentType: z.enum(["DAILY_JOURNAL", "EXPENSE"]).default("DAILY_JOURNAL"),
  note: z.string().min(1).max(500),
  acknowledgeWarnings: z.boolean().optional(),
  requestKey: z.string().min(8).max(120),
  preview: z.boolean().optional(),
  advanceId: z.string().min(1).optional(),
  receiptId: z.string().min(1).optional(),
  jobSheetId: z.string().min(1).optional(),
  jobNo: z.string().min(1).max(60).optional(),
  amount: z.number().finite().positive().optional(),
  bankAccount: z.string().max(120).optional(),
  bankRef: z.string().max(120).optional(),
  allocations: z.array(allocation).max(20).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can record an existing PEAK document"] }, { status: 403 });
  // Not gated on the cutover freeze: this is the one path that has to work WHILE
  // writes are frozen, because reconciling the old records is why they are frozen.
  // Its own switch (ADVANCE_EXISTING_PEAK_LINKS_ENABLED) governs it instead, and
  // linkExistingPeakDocument refuses — 503 off, 409 while the sender is on — so the
  // rule holds for anything calling the service directly too.

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const b = parsed.data;
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };

  let request: LinkRequest;
  const shared = { documentNo: b.documentNo, documentType: b.documentType, note: b.note, acknowledgeWarnings: b.acknowledgeWarnings, requestKey: b.requestKey, actor };
  if (b.kind === "ADVANCE") {
    if (!b.advanceId) return NextResponse.json({ error: "bad-body", reasons: ["Which advance is this document for?"] }, { status: 400 });
    request = { ...shared, kind: "ADVANCE", advanceId: b.advanceId };
  } else if (b.kind === "RETURN") {
    if (!b.receiptId) return NextResponse.json({ error: "bad-body", reasons: ["Which return is this document for?"] }, { status: 400 });
    request = { ...shared, kind: "RETURN", receiptId: b.receiptId, bankAccount: b.bankAccount ?? null, bankRef: b.bankRef ?? null, allocations: b.allocations ?? [] };
  } else {
    if (!b.advanceId || !b.amount || !(b.jobSheetId || b.jobNo)) {
      return NextResponse.json({ error: "bad-body", reasons: ["A ticket settlement needs the advance, the job sheet and the amount the document carries"] }, { status: 400 });
    }
    // Screens know the Job No.; the ledger keys on the sheet. Resolve it here, for the
    // guide who holds the advance, so a Job No. typed for another guide cannot match.
    let jobSheetId = b.jobSheetId ?? "";
    if (!jobSheetId) {
      const advance = await prisma.guideAdvance.findUnique({ where: { id: b.advanceId }, select: { guideId: true } });
      if (!advance) return NextResponse.json({ error: "not-found", reasons: ["No such advance"] }, { status: 404 });
      const sheet = await prisma.jobSheet.findFirst({ where: { ref: b.jobNo!.trim(), guideId: advance.guideId }, select: { id: true } });
      if (!sheet) return NextResponse.json({ error: "not-found", reasons: [`No job sheet ${b.jobNo} for this guide`] }, { status: 404 });
      jobSheetId = sheet.id;
    }
    request = { ...shared, kind: "EXPENSE", advanceId: b.advanceId, jobSheetId, amount: b.amount };
  }

  // A preview runs exactly the same checks and writes nothing. It exists so the
  // screen can show what will happen — not so the screen can decide whether it may.
  if (b.preview) {
    const result = await previewLink(prisma, request);
    if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
    return NextResponse.json(result);
  }

  const result = await linkExistingPeakDocument(prisma, request);
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
