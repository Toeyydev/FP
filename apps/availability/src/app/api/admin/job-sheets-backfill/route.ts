import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { createMissingSheets, upcomingJobsWithoutSheet } from "@/lib/jobsheet-backfill";

export const dynamic = "force-dynamic";

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview") }),
  z.object({ action: z.literal("apply"), hash: z.string().regex(/^[0-9a-f]{32}$/) }),
]);

// POST — admin only (session AND database role). Job sheets for upcoming jobs that have none
// (lib/jobsheet-backfill).
//   { action: "preview" }        lists them; changes nothing
//   { action: "apply", hash }    creates exactly the previewed list, or refuses if it changed
export async function POST(req: NextRequest) {
  const session = await auth();
  const no = NextResponse.json({ error: "forbidden", reasons: ["Only an admin can create job sheets in bulk"] }, { status: 403 });
  if (!isAdmin(session?.user?.role) || !session?.user?.id) return no;
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, state: true } });
  if (me?.role !== "ADMIN" || me.state !== "ACTIVE") return no;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (parsed.data.action === "preview") return NextResponse.json({ ok: true, ...(await upcomingJobsWithoutSheet(prisma, today())) });
  const r = await createMissingSheets(prisma, { hash: parsed.data.hash, today: today(), actor: { actorId: session.user.id, actorRole: "ADMIN" } });
  if (!r.ok) return NextResponse.json({ error: "refused", reasons: [r.reason] }, { status: r.status });
  return NextResponse.json(r);
}
