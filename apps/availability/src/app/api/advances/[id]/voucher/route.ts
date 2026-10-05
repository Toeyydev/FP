import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance, isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { issueVoucherFor } from "@/lib/advances/voucher-issue";
import { advanceVoucherHtml } from "@/lib/advances/voucher";
import { voucherApprover } from "@/lib/advances/voucher-approver";

export const dynamic = "force-dynamic";

// GET — the voucher itself, as a page the browser can print or save as PDF.
//
// Rendered from the ledger on every request rather than served from a stored file,
// so a voucher can never show figures the ledger has moved past. The Drive copy is
// the filed one; this is the live one.
//
// Readable by the finance roles and by the guide it belongs to — nobody else, since
// it carries a bank reference and an amount.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const role = session?.user?.role;
  const myGuideId = session?.user?.guideId ?? null;
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const advance = await prisma.guideAdvance.findUnique({ where: { id } });
  if (!advance) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (!canViewFinance(role) && myGuideId !== advance.guideId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [guide, sheet] = await Promise.all([
    prisma.user.findUnique({ where: { guideId: advance.guideId }, select: { displayName: true } }),
    advance.jobNo
      ? prisma.jobSheet.findFirst({ where: { ref: advance.jobNo, guideId: advance.guideId }, select: { date: true, tourId: true } })
      : Promise.resolve(null),
  ]);
  const tour = sheet?.tourId ? await prisma.tour.findUnique({ where: { id: sheet.tourId }, select: { name: true } }) : null;

  const approver = await voucherApprover(advance.createdById).catch(() => null);
  const html = advanceVoucherHtml({
    advanceNo: advance.advanceNo, guideId: advance.guideId, guideName: guide?.displayName,
    jobNo: advance.jobNo, tourName: tour?.name, tourDate: sheet?.date,
    advanceDate: advance.advanceDate, amountSatang: advance.amountSatang,
    purpose: advance.purpose, method: advance.method, txRef: advance.txRef,
    slipUrl: advance.slipUrl, peakDocumentNo: advance.peakDocumentNo,
    acknowledgedAt: advance.acknowledgedAt, approver,
  });
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// POST — file the voucher in Drive again, from the ledger as it is now. For a voucher filed
// before something it prints was on record (the approver's signature, the PEAK document
// number, the guide's acknowledgement). The Drive copy of the same name is replaced; the
// advance itself is not touched.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const advance = await prisma.guideAdvance.findUnique({ where: { id }, select: { advanceNo: true, voucherUrl: true } });
  if (!advance) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const voucherUrl = await issueVoucherFor(id);
  if (!voucherUrl) return NextResponse.json({ error: "not-filed", reasons: ["The voucher could not be filed in Google Drive — check the Drive connection and try again"] }, { status: 502 });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "advance.voucher_reissued", entityType: "GuideAdvance", entityId: id, detail: { advanceNo: advance.advanceNo, before: advance.voucherUrl, after: voucherUrl } });
  return NextResponse.json({ ok: true, voucherUrl });
}
