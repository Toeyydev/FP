import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/app/api/admin/historical-evidence/access";
import { detachMisattributedSlip, MIN_REASON, planSlipDetach, renameState, retrySlipRename, SlipCorrectionRefused, type CorrectionActor } from "@/lib/payment-slip-correction";

export const dynamic = "force-dynamic";

// Taking a payment slip off the job it was wrongly attached to (lib/payment-slip-correction).
//
// GET   the plan: what would change, what stays, and why it would be refused. Reads only —
//       not even a refusal is written.
// POST  { action: "detach", …target, reason }   the correction
//       { action: "retry_rename", tourPaymentId } repeat a failed Drive rename, exactly
//
// ADMIN only, in the session and in the database. The acting admin is taken from the
// session and read back from the database; a body never says who is acting or when, and
// is strict, so one that tries is refused rather than trimmed.

const target = {
  guideId: z.string().regex(/^G-\d{3,4}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotIdx: z.coerce.number().int().min(0).max(20),
  tourPaymentId: z.string().min(10).max(40),
  driveFileId: z.string().regex(/^[A-Za-z0-9_-]{10,}$/),
  rightfulGuideId: z.string().regex(/^G-\d{3,4}$/),
};
const targetZ = z.object(target).strict();
const bodyZ = z.discriminatedUnion("action", [
  z.object({ action: z.literal("detach"), ...target, slotIdx: z.number().int().min(0).max(20), reason: z.string().min(MIN_REASON).max(500) }).strict(),
  z.object({ action: z.literal("retry_rename"), tourPaymentId: z.string().min(10).max(40) }).strict(),
]);

const refused = (e: SlipCorrectionRefused) => NextResponse.json({ error: "refused", reasons: e.reasons }, { status: e.status });

async function actorFor(userId: string): Promise<CorrectionActor | null> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, fullName: true, displayName: true, email: true } });
  return me && me.role === "ADMIN" ? { id: me.id, role: me.role, name: (me.fullName || me.displayName || me.email || me.id).trim() } : null;
}

export async function GET(req: NextRequest) {
  const who = await requireAdmin();
  if (!who.ok) return NextResponse.json({ error: "forbidden" }, { status: who.status });
  const parsed = targetZ.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad-query", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  try {
    const [plan, state] = await Promise.all([
      planSlipDetach(parsed.data).catch((e) => { if (e instanceof SlipCorrectionRefused && e.status === 404) return null; throw e; }),
      renameState(parsed.data.tourPaymentId),
    ]);
    return NextResponse.json({ ok: true, plan, correction: state ? { auditId: state.auditId, correctedAt: state.correctedAt, rename: state.rename, renamed: state.renamed } : null });
  } catch (e) {
    if (e instanceof SlipCorrectionRefused) return refused(e);
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const who = await requireAdmin();
  if (!who.ok) {
    await audit({ action: "pay.slip_detach_denied", entityType: "TourPayment", detail: { status: who.status } }).catch(() => {});
    return NextResponse.json({ error: "forbidden" }, { status: who.status });
  }
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, { status: 400 });
  const actor = await actorFor(who.userId);
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const b = parsed.data;
    if (b.action === "detach") {
      const { action: _a, ...input } = b;
      return NextResponse.json({ ok: true, ...(await detachMisattributedSlip(input, actor)) });
    }
    return NextResponse.json({ ok: true, drive: await retrySlipRename(b.tourPaymentId, actor) });
  } catch (e) {
    if (e instanceof SlipCorrectionRefused) return refused(e);
    throw e;
  }
}
