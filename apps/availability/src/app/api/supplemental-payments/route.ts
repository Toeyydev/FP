import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance, isOps } from "@/lib/roles";
import { supplementalBody } from "@/lib/supplemental-payments/request-schema";
import { createSupplemental, listSupplementals } from "@/lib/supplemental-payments/service";

export const dynamic = "force-dynamic";

// GET ?guideId= — supplemental payments, each with where it stands (unpaid / paid /
// accounting pending / reconciled / void). Finance roles only.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") || null;
  return NextResponse.json({ rows: await listSupplementals(prisma, { guideId }) });
}

// POST — create one, UNPAID. It is paid later by its own transfer (Record payment), and it
// never changes the payment it supplements. Operators and admins only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = supplementalBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const result = await createSupplemental(prisma, { ...parsed.data, actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  if (!result.ok) return NextResponse.json({ error: "not-creatable", reasons: result.reasons, duplicates: result.duplicates }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id, replayed: result.replayed });
}
