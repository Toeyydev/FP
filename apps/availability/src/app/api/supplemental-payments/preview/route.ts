import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { supplementalBody } from "@/lib/supplemental-payments/request-schema";
import { previewSupplemental } from "@/lib/supplemental-payments/service";

export const dynamic = "force-dynamic";

// POST — what Create would make (gross, tax, net, account) and every reason it would be
// refused, including payments it looks like a duplicate of. Writes nothing.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = supplementalBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  return NextResponse.json(await previewSupplemental(prisma, parsed.data));
}
