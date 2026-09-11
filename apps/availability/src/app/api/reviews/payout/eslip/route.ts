import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { notifyGuide } from "@/lib/booking-import";
import { thb } from "@/lib/jobsheet";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (m: string) => (m.includes("png") ? "png" : m.includes("pdf") ? "pdf" : m.includes("webp") ? "webp" : "jpg");

// POST (multipart) { payoutId, file } — upload the transfer slip for a review
// payout → Drive ("Folkpaths E-slips/<month>", same folder as all other slips),
// mark the payout + its reviews PAID, and tell the guide. Mirrors the bonus
// e-slip flow.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Connect Google Drive first." }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const payoutId = String(form?.get("payoutId") || "");
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!payoutId || !file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });

  const payout = await prisma.reviewPayout.findUnique({ where: { id: payoutId }, include: { _count: { select: { reviews: true } } } });
  if (!payout) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect the Folkpaths Google account first." }, { status: 400 });

  const u = await prisma.user.findFirst({ where: { guideId: payout.guideId }, select: { displayName: true, fullName: true } });
  const guideName = u?.fullName || u?.displayName || payout.guideId;
  const mime = file.type || "image/jpeg";
  const period = payout.periodEnd.slice(0, 7);
  const monthFolder = `${period} ${MONTHS[Number(period.slice(5, 7)) - 1] ?? ""}`.trim();
  const name = `${payout.ref} — ${payout.guideId} ${guideName} — review incentives.${extOf(mime)}`;

  let link: string;
  try {
    const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
    ({ link } = await saveBufferToDrive({ refreshToken, name, base64, mimeType: mime, folderPath: ["Folkpaths E-slips", monthFolder] }));
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  await prisma.$transaction([
    prisma.reviewPayout.update({ where: { id: payoutId }, data: { eslipUrl: link, status: "PAID", paidAt: payout.paidAt ?? new Date() } }),
    prisma.review.updateMany({ where: { payoutBatchId: payoutId }, data: { paymentStatus: "PAID" } }),
  ]);
  try {
    await notifyGuide(payout.guideId, `Your review bonus has been transferred — ${thb(payout.totalAmount)} for ${payout._count.reviews} review${payout._count.reviews === 1 ? "" : "s"}. ⭐`, "Review bonus transferred ⭐", `${thb(payout.totalAmount)} · ${payout.ref}`);
  } catch { /* best-effort */ }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "review_payout.eslip_uploaded", entityType: "ReviewPayout", entityId: payoutId, detail: { ref: payout.ref, guideId: payout.guideId, total: payout.totalAmount } });
  return NextResponse.json({ ok: true, link });
}
