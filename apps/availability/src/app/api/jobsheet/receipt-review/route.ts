import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { notifyGuide } from "@/lib/booking-import";
import { reviewReceipts } from "@/lib/job-expense-review";

export const dynamic = "force-dynamic";

// POST — the operator's review of a Company ADV ticket row's receipts (lib/job-expense-review).
// OPERATOR / ADMIN. VERIFY / REJECT / REQUEST_NEW (a note the guide reads; the guide is told) or
// NOTE (internal). Never settles the advance, never touches PEAK.
const body = z.object({
  guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
  rowId: z.string().min(1).max(64),
  action: z.enum(["VERIFY", "REJECT", "REQUEST_NEW", "NOTE"]),
  note: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an operator can review receipts"] }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const r = await reviewReceipts(prisma, { ...parsed.data, actor: { id: session!.user!.id ?? null, role: session!.user!.role ?? null } },
    async (guideId, message) => { await notifyGuide(guideId, message, "Ticket receipt", message, undefined, { url: `/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${parsed.data.date}&slotIdx=${parsed.data.slotIdx}` }); });
  if (!r.ok) return NextResponse.json({ error: "not-allowed", reasons: r.reasons, detail: r.reasons.join("\n") }, { status: r.status });
  return NextResponse.json(r);
}
