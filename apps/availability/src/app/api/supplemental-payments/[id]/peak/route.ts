import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { putReviewIncentiveInPeak, resolveReviewIncentivePeak } from "@/lib/supplemental-payments/peak";

export const dynamic = "force-dynamic";

// POST { paymentMethodId } — put a paid, company-borne review incentive into PEAK as its own
// document (510110, income = transfer + tax) and record its payment. Safe to press again:
// a document already created is paid, never created twice (lib/supplemental-payments/peak).
// PATCH { resolution } — after PEAK did not answer, record what a person found there.
const post = z.object({ paymentMethodId: z.string().min(1).max(80) });
const patch = z.object({ resolution: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), documentNo: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("not-created") }),
  z.object({ kind: z.literal("payment-found") }),
  z.object({ kind: z.literal("payment-not-found") }),
]) });

async function gate() {
  const session = await auth();
  if (!isOps(session?.user?.role)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if ("error" in g) return g.error;
  const parsed = post.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const r = await putReviewIncentiveInPeak(prisma, { id: (await params).id, paymentMethodId: parsed.data.paymentMethodId, actor: g.actor });
  if (!r.ok) return NextResponse.json({ error: "refused", reasons: r.reasons }, { status: r.status });
  return NextResponse.json(r);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if ("error" in g) return g.error;
  const parsed = patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const r = await resolveReviewIncentivePeak(prisma, { id: (await params).id, resolution: parsed.data.resolution, actor: g.actor });
  if (!r.ok) return NextResponse.json({ error: "refused", reasons: r.reasons }, { status: r.status });
  return NextResponse.json(r);
}
