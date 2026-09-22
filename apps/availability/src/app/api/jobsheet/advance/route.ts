import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { notifyGuide } from "@/lib/booking-import";
import { thb } from "@/lib/jobsheet";
import { uploadSlip } from "@/lib/advance-slip";
import { recordAdvanceReturn } from "@/lib/guide-advance";
import { issueAdvance } from "@/lib/advances/service";
import { jobAdvanceView } from "@/lib/advances/job-view";
import type { Expense } from "@/lib/jobsheet";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { bangkokToday } from "@/lib/payments-v2/rules";

// Guide advances + returns for one job (guideId + date + slotIdx). An advance is a
// cash movement, never an expense (see lib/advance). Operators/admin record both;
// the GUIDE may record a RETURN on their own job (they made the transfer back) but
// can never create or change an advance. Optional slip file goes to the same Drive
// store as receipts/e-slips (Folkpaths Job Sheets / <month> / Advances).

const key = (guideId: string, date: string, slotIdx: number) => ({ guideId, date, slotIdx });
/** The job's advances as the ledger holds them — the same view the sheet loads with. */
async function viewFor(guideId: string, date: string, slotIdx: number) {
  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key(guideId, date, slotIdx) }, select: { expenses: true } });
  return jobAdvanceView(prisma, { guideId, date, slotIdx, expenses: (sheet?.expenses as unknown as Expense[]) ?? [] });
}

/** The Bangkok calendar date of a moment — the date the bank actually moved the money. */
const bangkokDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);


// POST (multipart) — record an advance or a return on a job.
// Fields: kind ("advance" | "return"), guideId, date, slotIdx, amount, at (ISO or
// "YYYY-MM-DDTHH:mm"), method, txRef?, peakRef? (advance only), note?, advanceId?
// (return only), file? (transfer slip).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Cutover: no advance or return may be written while the ledger is being migrated.
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const kind = String(form.get("kind") || "");
  const guideId = String(form.get("guideId") || "");
  const date = String(form.get("date") || "");
  const slotIdx = Number(form.get("slotIdx"));
  const amount = Number(String(form.get("amount") || "").replace(/[,\s]/g, ""));
  const atRaw = String(form.get("at") || "");
  const at = atRaw ? new Date(atRaw) : new Date();
  const method = (String(form.get("method") || "bank").slice(0, 24)) || "bank";
  const bankAccount = String(form.get("bankAccount") || "").slice(0,120) || null;
  const txRef = String(form.get("txRef") || "").slice(0, 120) || null;
  const peakRef = String(form.get("peakRef") || "").slice(0, 60) || null;
  const note = String(form.get("note") || "").slice(0, 500) || null;
  const advanceId = String(form.get("advanceId") || "") || null;
  // Only an operator who has seen the money in the company account may say so.
  const confirmedArrived = String(form.get("confirmedArrived") || "") === "1";
  const file = form.get("file") as unknown as { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;

  if (!(kind === "advance" || kind === "return") || !guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "bad-amount", hint: "Enter a positive amount in baht." }, { status: 400 });
  if (isNaN(at.getTime())) return NextResponse.json({ error: "bad-date" }, { status: 400 });

  // Authorization: operators do everything; the job's own guide may record a RETURN
  // (they made the transfer) but never an advance.
  const opsUser = isOps(session.user.role);
  if (!opsUser && !(kind === "return" && session.user.guideId === guideId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (method === "bank" && !txRef) return NextResponse.json({ error: "bad-body", hint: "Enter the bank transfer reference." }, { status: 400 });
  if (!file || typeof file.arrayBuffer !== "function" || !(file.size && file.size > 0)) return NextResponse.json({ error: "bad-body", hint: "Attach the transfer slip." }, { status: 400 });
  if (opsUser && method === "bank" && !bankAccount) return NextResponse.json({ error: "bad-body", hint: "Choose the company bank account used for this transfer." }, { status: 400 });

  // A return goes through the shared rules (lib/guide-advance), which FolkOPS
  // Mobile uses too, so a return filed from a phone is the same row — with its
  // slip in the same Drive folder — as one typed here.
  if (kind === "return") {
    const r = await recordAdvanceReturn({
      guideId, date, slotIdx, amount, at, method, txRef, note, advanceId, bankAccount,
      slipFile: file, actorId: session.user.id ?? null, actorRole: session.user.role ?? null, byGuide: !opsUser,
      confirmedArrived: opsUser && confirmedArrived,
    });
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.hint ? { hint: r.hint } : {}) }, { status: r.status });
    return NextResponse.json({ ok: true, ...(await viewFor(guideId, date, slotIdx)) });
  }

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key(guideId, date, slotIdx) }, select: { id: true, ref: true } });
  if (!sheet) return NextResponse.json({ error: "no-sheet", hint: "Save the job sheet first." }, { status: 404 });
  if (!sheet.ref) return NextResponse.json({ error: "bad-body", hint: "Assign a Job No. before recording an advance." }, { status: 400 });
  const gUser = await prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } });
  const guideName = gUser?.fullName || gUser?.displayName || guideId;

  // Accidental double-submit guard: an identical amount recorded on this job within
  // the last minute is almost certainly the same click twice.
  const dupWindow = new Date(Date.now() - 60_000);
  const dup = kind === "advance"
    ? await prisma.guideAdvance.findFirst({ where: { ...key(guideId, date, slotIdx), amount, createdAt: { gte: dupWindow } } })
    : await prisma.guideAdvanceReturn.findFirst({ where: { ...key(guideId, date, slotIdx), amount, createdAt: { gte: dupWindow } } });
  if (dup) return NextResponse.json({ error: "duplicate", hint: "This amount was just recorded — refresh before recording it again." }, { status: 409 });

  let slip: { url: string; fileId: string } | null = null;
  if (file && typeof file.arrayBuffer === "function" && (file.size ?? 0) > 0) {
    // Same naming convention as every other Drive file of this job
    // ("<ref> — <guide> — <date> — …") so a job's documents sort together.
    const base = `${kind === "advance" && peakRef ? `${peakRef} — ` : ""}${sheet.ref || `${guideId}-${date}`} — ${guideName} — ${date}`;
    const up = await uploadSlip(session.user.id ?? undefined, file, `${base} — ${kind === "advance" ? "advance" : "advance return"} ฿${amount}`, date);
    if ("error" in up) return NextResponse.json({ error: up.error }, { status: up.status });
    slip = up;
  }

  const createdById = session.user.id ?? null;
  if (kind === "advance") {
    // Phase 3: an advance is a ledger row now — one writer, one set of rules
    // (lib/advances/service), whether it is recorded here or from the Advances screen.
    const issued = await issueAdvance(prisma, {
      guideId, advanceDate: bangkokDate(at), amount, jobNo: sheet.ref ?? null,
      method, bankAccount, bankRef: txRef, note, today: bangkokToday(),
      slipUrl: slip?.url ?? null, slipFileId: slip?.fileId ?? null,
      date, slotIdx, actor: { actorId: createdById, actorRole: session.user.role ?? null },
    });
    if (!issued.ok) return NextResponse.json({ error: "not-allowed", reasons: issued.reasons, detail: issued.reasons.join("\n") }, { status: issued.status });
    const row = { id: issued.advance.id };
    if (peakRef) await prisma.guideAdvance.update({ where: { id: row.id }, data: { peakRef } });
    // The guide must know money was sent: in-app + push + LINE (if linked) + email
    // fallback — same pipeline as booking changes. Best-effort, never blocks the record.
    await notifyGuide(
      guideId,
      `Folkpaths sent you a ticket advance of ${thb(amount)} for your ${date} tour${sheet.ref ? ` (${sheet.ref})` : ""}. Use it only to buy customer tickets. After the tour, report the ticket costs and return any unused amount.`,
      "Ticket advance sent",
      `${date} · ${thb(amount)} ticket advance`,
    );
  }

  return NextResponse.json({ ok: true, ...(await viewFor(guideId, date, slotIdx)) });
}

// DELETE — retired by Phase 3.
//
// Advances and returns are financial records on the ledger now; a mis-entry is corrected
// by reversing it with a reason, never by deleting the row. It still answers, rather than
// 404, so an old tab gets told where to go.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void req;
  const reason = "An advance or a return is a financial record and is not deleted. Open Payments → Advances: reverse the advance (if the money never left the bank) or the entry that was wrong, with a reason.";
  return NextResponse.json({ error: "reverse-instead", reasons: [reason], detail: reason }, { status: 409 });
}
