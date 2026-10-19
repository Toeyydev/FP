import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isAdmin } from "@/lib/roles";
import { saveJobSheetToDrive } from "@/lib/jobsheet-drive";

export const dynamic = "force-dynamic";

// A PDF render takes a few seconds; a small batch keeps each request well inside a timeout.
const BATCH = 5;
const key = z.object({ guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) });
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview") }),
  z.object({ action: z.literal("save"), sheets: z.array(key).min(1).max(BATCH) }),
]);

// POST — admin only (session AND database role). Files every APPROVED job sheet in the
// Folkpaths Drive as a PDF (lib/jobsheet-drive), replacing a same-named PDF in place.
//   { action: "preview" }          lists the approved sheets; changes nothing
//   { action: "save", sheets }     saves up to 5 of them; the page sends the list in batches
// It writes no row: the sheets are read, rendered and uploaded. Older Google Doc copies in
// Drive are left as they are.
export async function POST(req: NextRequest) {
  const session = await auth();
  const no = NextResponse.json({ error: "forbidden", reasons: ["Only an admin can re-save job sheets in bulk"] }, { status: 403 });
  if (!isAdmin(session?.user?.role) || !session?.user?.id) return no;
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, state: true } });
  if (me?.role !== "ADMIN" || me.state !== "ACTIVE") return no;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: [`Send at most ${BATCH} sheets at a time.`] }, { status: 400 });

  if (parsed.data.action === "preview") {
    const sheets = await prisma.jobSheet.findMany({
      where: { approvalStatus: "APPROVED" },
      select: { guideId: true, date: true, slotIdx: true, ref: true },
      orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { guideId: "asc" }],
    });
    return NextResponse.json({ ok: true, batch: BATCH, sheets });
  }

  const results = [];
  for (const s of parsed.data.sheets) {
    // Only an approved sheet: this tool files decisions, not drafts.
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: s }, select: { approvalStatus: true, ref: true } });
    if (sheet?.approvalStatus !== "APPROVED") { results.push({ ...s, ok: false, error: "not approved" }); continue; }
    const link = await saveJobSheetToDrive(s.guideId, s.date, s.slotIdx);
    results.push({ ...s, ref: sheet.ref, ok: !!link, link, ...(link ? {} : { error: "PDF not saved" }) });
  }
  await audit({ actorId: session.user.id, actorRole: "ADMIN", action: "jobsheet.drive_pdf_bulk", entityType: "JobSheet",
    detail: { saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => ({ guideId: r.guideId, date: r.date, slotIdx: r.slotIdx, error: r.error })) } });
  return NextResponse.json({ ok: true, results });
}
