import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { AttachRefused, resolveAttachment } from "@/lib/certificates/peak-attach";
import { attachCertificateToPeak, retryRefusedAttachment } from "@/lib/certificates/peak-attach-send";

export const dynamic = "force-dynamic";

// POST — admin only. Putting a filed certificate's PDF on its EXP in PEAK
// (lib/certificates/peak-attach-send), and recording what a person saw there.
//   { action: "attach", certificateId }          send now (the loop would, within minutes)
//   { action: "retry", attachmentId }            send a REFUSED attempt again, same ledger row
//   { action: "resolve", attachmentId, finding, note? }   FOUND_IN_PEAK | NOT_FOUND_IN_PEAK
// Nothing here changes an amount, a line, withholding or a payment in PEAK.
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("attach"), certificateId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("retry"), attachmentId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("resolve"), attachmentId: z.string().min(1).max(64), finding: z.enum(["FOUND_IN_PEAK", "NOT_FOUND_IN_PEAK"]), note: z.string().max(500).optional() }),
]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can send a certificate to PEAK"] }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const actor = { id: session!.user!.id ?? "", role: session!.user!.role ?? "ADMIN" };
  const d = parsed.data;
  if (d.action === "resolve") {
    try {
      const row = await resolveAttachment(d.attachmentId, d.finding, actor, d.note ?? null);
      return NextResponse.json({ ok: true, state: row.state });
    } catch (e) {
      if (e instanceof AttachRefused) return NextResponse.json({ error: "refused", reasons: e.reasons }, { status: e.status });
      throw e;
    }
  }
  const r = d.action === "attach"
    ? await attachCertificateToPeak(d.certificateId, { actorId: actor.id, actorRole: actor.role })
    : await retryRefusedAttachment(d.attachmentId, actor);
  if (!r.ok) return NextResponse.json({ error: "refused", reasons: r.reasons }, { status: r.status });
  return NextResponse.json(r);
}
