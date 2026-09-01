import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { Prisma } from "@prisma/client";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { sendPaymentNotice } from "@/lib/jobsheet-send";
import { peakEnabled } from "@/lib/peak-api";
import { postGuidePayout, peakPayoutReady } from "@/lib/peak-payout";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { matchState, type Slip } from "@/lib/payments/slips";

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

  // Split-payment mode: an optional per-slip amount. When present, this slip is one
  // of several transfers that must sum to a SINGLE tour's payout, so it only applies
  // to one job.
  const amountRaw = form?.get("amount");
  const hasAmount = amountRaw != null && String(amountRaw).trim() !== "";
  const amount = hasAmount ? Number(String(amountRaw).replace(/[,\s]/g, "")) : null;
  if (hasAmount && (!Number.isFinite(amount) || (amount as number) <= 0)) return NextResponse.json({ error: "bad-amount", hint: "Enter the slip amount in baht." }, { status: 400 });
  if (hasAmount && jobs.length !== 1) return NextResponse.json({ error: "split-single-only", hint: "A slip amount applies to one tour at a time." }, { status: 400 });

  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect the Folkpaths Google account first." }, { status: 400 });

  const u = await prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } });
  const guideName = u?.fullName || u?.displayName || guideId;
  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const mime = file.type || "image/jpeg";

  // ---- Split-payment: add ONE slip (with its amount) to ONE tour ----
  // The tour's payout can be settled across several transfers; each call appends a
  // slip, keeps every slip in Drive (numbered, no overwrite), and marks the tour
  // PAID only when the slips sum EXACTLY to its payout. A mismatch is reported back
  // (over/under) and stays unpaid so the operator can correct it.
  if (hasAmount) {
    const j = jobs[0];
    const now = new Date();
    const uid = session!.user!.id ?? null;
    const [sheet, a, existing] = await Promise.all([
      prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } }, select: { expenses: true, guideFee: true } }),
      prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } }, select: { tourId: true } }),
      prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } }, select: { status: true, slips: true, eslipUrl: true, peakRef: true, tourId: true } }),
    ]);
    const payout = computeTotals((sheet?.expenses as unknown as Expense[]) ?? [], (sheet?.guideFee as unknown as GuideFee) ?? DEFAULT_GUIDE_FEE).grandTotal;
    const prior = (Array.isArray(existing?.slips) ? existing!.slips : []) as unknown as Slip[];
    const seq = prior.length + 1;
    const mf = `${j.date.slice(0, 7)} ${MONTHS[Number(j.date.slice(5, 7)) - 1] ?? ""}`.trim();
    const slipName = `${guideId} ${guideName} — ${j.date} — e-slip ${seq}.${extOf(mime)}`;
    let link: string | null = null;
    let driveError: string | undefined;
    try {
      ({ link } = await saveBufferToDrive({ refreshToken, name: slipName, base64, mimeType: mime, folderPath: ["Folkpaths E-slips", mf] }));
    } catch (e) { driveError = (e as Error).message.slice(0, 200); }
    const slips: Slip[] = [...prior, { amount: amount as number, url: link, at: now.toISOString(), name: slipName }];
    const st = matchState(slips, payout);
    const wasPaid = existing?.status === "PAID";
    const data = {
      status: st.paid ? "PAID" : "PENDING",
      approvedBy: uid,
      paidAt: st.paid ? now : null,
      peakRef: peakRef ?? existing?.peakRef ?? null,
      eslipUrl: link ?? existing?.eslipUrl ?? null,
      slips: slips as unknown as Prisma.InputJsonValue,
    };
    await prisma.tourPayment.upsert({
      where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } },
      create: { guideId, date: j.date, slotIdx: j.slotIdx, tourId: a?.tourId ?? existing?.tourId ?? "", ...data },
      update: data,
    });
    await audit({ actorId: uid, actorRole: session!.user!.role ?? null, action: "pay.eslip_split", entityType: "Assignment", detail: { guideId, date: j.date, slotIdx: j.slotIdx, amount, slipsTotal: st.slipsTotal, payout: st.payout, paid: st.paid, drive: !!link } });
    // Only when the tour first becomes fully paid: post to PEAK + notify the guide once.
    let peakCode: string | null = null;
    if (st.paid && !wasPaid) {
      try {
        if (peakEnabled && peakPayoutReady && !data.peakRef) {
          const r = await postGuidePayout(guideId, [j], now.toISOString().slice(0, 10));
          if (r.ok && r.code) { peakCode = r.code; await prisma.tourPayment.update({ where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } }, data: { peakRef: r.code } }); }
        }
      } catch { /* PEAK posting is best-effort; payment already recorded */ }
      try { await sendPaymentNotice(guideId, [j], undefined, link ?? undefined); } catch { /* best-effort */ }
    }
    return NextResponse.json({ ok: true, link, slips, slipsTotal: st.slipsTotal, payout: st.payout, remaining: st.remaining, paid: st.paid, warn: st.warn, delta: st.delta, count: slips.length, driveError, peakRef: peakCode ?? data.peakRef });
  }

  // ---- Guard: never let a second slip overwrite the first ----
  // Without an amount this path REPLACES eslipUrl and marks every listed tour PAID.
  // That is right for one transfer covering several tours, and wrong for a second
  // transfer topping up a tour that was short: the first slip would be unlinked
  // (the file survives in Drive, nothing points at it) and the tour would read as
  // fully settled while money was still owed. Splitting a payment has its own
  // path, which sums the slips and only marks PAID at an exact match.
  const alreadySlipped = await prisma.tourPayment.findMany({
    where: { OR: jobs.map((j) => ({ guideId, date: j.date, slotIdx: j.slotIdx })) },
    select: { date: true, slotIdx: true, eslipUrl: true, slips: true },
  });
  const hasSlipAlready = alreadySlipped.filter(
    (p) => p.eslipUrl || (Array.isArray(p.slips) && p.slips.length > 0),
  );
  if (hasSlipAlready.length) {
    return NextResponse.json({
      error: "slip-exists",
      detail: `${hasSlipAlready.length} of these tours already has a slip. To record a second transfer use "Add another transfer", which asks for the amount and only marks the tour paid once the slips add up. · งานนี้มีสลิปแล้ว ถ้าจะบันทึกการโอนอีกครั้งให้ใช้ปุ่ม "โอนเพิ่ม" ซึ่งจะถามยอดและจะขึ้นว่าจ่ายครบเมื่อรวมกันพอดี`,
    }, { status: 409 });
  }

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
  try { await sendPaymentNotice(guideId, jobs, undefined, link); } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, link, count: jobs.length, peakRef: peakCode ?? peakRef });
}

// DELETE { guideId, date, slotIdx, at } — remove ONE split-payment slip (by its
// timestamp) from a tour and recompute against the payout. The Drive file is left
// in place (recoverable). Dropping below an exact match reverts the tour to unpaid.
// Operator/admin only.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  const at = String(body?.at || "");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0) || !at) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const [existing, sheet] = await Promise.all([
    prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { slips: true } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { expenses: true, guideFee: true } }),
  ]);
  if (!existing) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const prior = (Array.isArray(existing.slips) ? existing.slips : []) as unknown as Slip[];
  const slips = prior.filter((s) => s?.at !== at);
  const payout = computeTotals((sheet?.expenses as unknown as Expense[]) ?? [], (sheet?.guideFee as unknown as GuideFee) ?? DEFAULT_GUIDE_FEE).grandTotal;
  const st = matchState(slips, payout);
  const last = slips[slips.length - 1];
  await prisma.tourPayment.update({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    data: { slips: slips as unknown as Prisma.InputJsonValue, status: st.paid ? "PAID" : "PENDING", paidAt: st.paid ? new Date() : null, eslipUrl: last?.url ?? null },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "pay.eslip_split_remove", entityType: "Assignment", detail: { guideId, date, slotIdx, at, slipsTotal: st.slipsTotal, payout: st.payout, paid: st.paid } });
  return NextResponse.json({ ok: true, slips, slipsTotal: st.slipsTotal, payout: st.payout, remaining: st.remaining, paid: st.paid, warn: st.warn, delta: st.delta });
}
