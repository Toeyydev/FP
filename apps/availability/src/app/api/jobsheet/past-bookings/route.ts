import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { syncPastSheet } from "@/lib/past-sheet-sync";

export const dynamic = "force-dynamic";

// POST — on a tour that already ran: add the bookings missing from its job sheet, and mark
// the departure's waiting bookings as guided by this guide (lib/past-sheet-sync). Operator
// or admin, by pressing the button on the job sheet; append-only and audited.
const body = z.object({
  guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
  bookingIds: z.array(z.string().min(1)).min(1).max(50), sheetVersion: z.string().min(10),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "OPERATOR" && role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const r = await syncPastSheet(prisma, { ...parsed.data, actor: { actorId: session!.user!.id ?? null, actorRole: role } });
  if (!r.ok) return NextResponse.json({ error: "not-allowed", reasons: r.reasons, detail: r.reasons.join("\n") }, { status: r.status });
  return NextResponse.json(r);
}
