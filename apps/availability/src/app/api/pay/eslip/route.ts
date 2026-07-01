import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { sendPaymentNotice } from "@/lib/jobsheet-send";
import { peakEnabled } from "@/lib/peak-api";
import { postGuidePayout, peakPayoutReady } from "@/lib/peak-payout";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

// POST (multipart) { guideId, jobs, peakRef? , file } — pay ONE or SEVERAL of a
// guide's tours in a single transfer: upload one bank slip, push it to Drive once,
// and mark every listed tour PAID with that slip + the shared PEAK ref. This is the
// "merged payment" path (e.g. a guide's 2-3 pending jobs paid together). Ops only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Connect Google Drive first." }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const guideId = String(form?.get("guideId") || "");
  const peakRef = String(form?.get("peakRef") || "").trim() || null;
  const jobsRaw = String(form?.get("jobs") || "[]");
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;

  const jobsParsed = z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).max(60).safeParse(JSON.parse(jobsRaw || "[]"));
  if (!guideId || !jobsParsed.success || jobsParsed.data.length === 0 || !file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });
  const jobs = jobsParsed.data;

  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect the Folkpaths Google account first." }, { status: 400 });

  const u = await prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } });
  const guideName = u?.fullName || u?.displayName || guideId;
  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const mime = file.type || "image/jpeg";
  const dates = [...new Set(jobs.map((j) => j.date))].sort();
  const earliest = dates[0];
  const monthFolder = `${earliest.slice(0, 7)} ${MONTHS[Number(earliest.slice(5, 7)) - 1] ?? ""}`.trim();
  const dateLabel = dates.length === 1 ? dates[0] : `${dates[0]}+${dates.length - 1}`;
  const name = `${guideId} ${guideName} — ${dateLabel} (${jobs.length} tour${jobs.length === 1 ? "" : "s"})${peakRef ? ` — ${peakRef}` : ""} — e-slip.${extOf(mime)}`;

  let link: string;
  try {
    ({ link } = await saveBufferToDrive({ refreshToken, name, base64, mimeType: mime, folderPath: ["Folkpaths E-slips", monthFolder] }));
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  // Mark every listed tour PAID, tagged with the one slip + shared ref.
  const now = new Date();
  const uid = session!.user!.id ?? null;
  for (const j of jobs) {
    const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } } });
    const data = { status: "PAID", approvedBy: uid, approvedAt: null, paidAt: now, peakRef, eslipUrl: link };
    await prisma.tourPayment.upsert({
      where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } },
      create: { guideId, date: j.date, slotIdx: j.slotIdx, tourId: a?.tourId ?? "", ...data },
      update: data,
    });
  }
  await audit({ actorId: uid, actorRole: session!.user!.role ?? null, action: "pay.eslip", entityType: "Assignment", detail: { guideId, count: jobs.length, peakRef, drive: true } });

  // Auto-post this transfer to PEAK as one expense and adopt its EXP- code as the
  // ref — dormant until PEAK is connected + account-chart config is set, so this is
  // a no-op today. Never blocks the payment.
  let peakCode: string | null = null;
  try {
    if (peakEnabled && peakPayoutReady && !peakRef) {
      const r = await postGuidePayout(guideId, jobs, now.toISOString().slice(0, 10));
      if (r.ok && r.code) {
        peakCode = r.code;
        await prisma.tourPayment.updateMany({ where: { guideId, OR: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) }, data: { peakRef: r.code } });
      }
    }
  } catch { /* PEAK posting is best-effort; payment already recorded */ }

  // Tell the guide their payment landed — short summary + completed tour details.
  try { await sendPaymentNotice(guideId, jobs); } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, link, count: jobs.length, peakRef: peakCode ?? peakRef });
}
