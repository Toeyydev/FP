import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { checkSheetAttachments } from "@/lib/certificates/receipt-kind";

export const dynamic = "force-dynamic";

// POST { guideId, date, slotIdx } — an admin asks FolkOPS to look at the files attached to
// this sheet's advance-paid rows and record which are bank transfer slips rather than
// tickets (lib/certificates/receipt-kind). Writes no job sheet row.
const key = z.object({ guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can check certificate evidence"] }, { status: 403 });
  const parsed = key.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const r = await checkSheetAttachments(prisma, parsed.data, { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null });
  if (!r.ok) return NextResponse.json({ error: "not-allowed", reasons: r.reasons }, { status: r.status });
  return NextResponse.json(r);
}
