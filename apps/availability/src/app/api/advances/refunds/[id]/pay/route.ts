import { accountingWriteRefusal } from "@/lib/advances/write-guard";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { payRefund } from "@/lib/advances/service";
import { uploadSlip } from "@/lib/advance-slip";

export const dynamic = "force-dynamic";

// POST { paidAt, bankRef, file? | slipUrl? } — step 3: the transfer to the guide was made
// (APPROVED → PAID). Multipart with the transfer slip, which goes to the company Drive through
// the same upload every advance slip uses (lib/advance-slip). A retry with the same bank
// reference is a no-op. Operators and admins only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  { const refused = await accountingWriteRefusal(prisma); if (refused) return NextResponse.json(refused.body, { status: refused.status }); }
  const { id } = await ctx.params;
  const multipart = req.headers.get("content-type")?.includes("multipart/form-data");
  const form = multipart ? await req.formData().catch(() => null) : null;
  const body = form ? { paidAt: String(form.get("paidAt") || ""), bankRef: String(form.get("bankRef") || ""), slipUrl: null as string | null } : ((await req.json().catch(() => ({}))) as { paidAt?: string; bankRef?: string; slipUrl?: string | null });
  const file = form?.get("file");
  let slip: { url: string; fileId: string } | null = null;
  if (file instanceof File && file.size > 0) {
    const refund = await prisma.guideAdvanceRefund.findUnique({ where: { id }, select: { refundNo: true, guideId: true, status: true } });
    if (!refund) return NextResponse.json({ error: "not-found", reasons: ["No such refund"] }, { status: 404 });
    if (refund.status !== "APPROVED") return NextResponse.json({ error: "not-allowed", reasons: [`${refund.refundNo} is ${refund.status.toLowerCase()} — a refund is paid only after it is approved`] }, { status: 409 });
    const paidDate = (body.paidAt || new Date().toISOString()).slice(0, 10);
    const up = await uploadSlip(session!.user!.id ?? undefined, file, `${refund.refundNo} — ${refund.guideId} — advance refund`, paidDate);
    if ("error" in up) return NextResponse.json({ error: up.error, reasons: [`The slip could not be stored (${up.error})`] }, { status: up.status });
    slip = up;
  }
  const result = await payRefund(prisma, {
    refundId: id, paidAt: body.paidAt ?? "", bankRef: body.bankRef ?? "",
    slipUrl: slip?.url ?? body.slipUrl ?? null, slipFileId: slip?.fileId ?? null,
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
