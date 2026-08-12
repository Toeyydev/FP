import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";

// Guide advances + returns for one job (guideId + date + slotIdx). An advance is a
// cash movement, never an expense (see lib/advance). Operators/admin record both;
// the GUIDE may record a RETURN on their own job (they made the transfer back) but
// can never create or change an advance. Optional slip file goes to the same Drive
// store as receipts/e-slips (Folkpaths Job Sheets / <month> / Advances).

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");
const OK_TYPES = /^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/i;
const key = (guideId: string, date: string, slotIdx: number) => ({ guideId, date, slotIdx });

async function uploadSlip(userId: string | undefined, file: { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> }, name: string, date: string): Promise<{ url: string; fileId: string } | { error: string; status: number }> {
  const mime = file.type || "image/jpeg";
  if (!OK_TYPES.test(mime)) return { error: "bad-type", status: 400 };
  if ((file.size ?? 0) > 10 * 1024 * 1024) return { error: "too-large", status: 400 };
  if (!googleDriveEnabled) return { error: "not-configured", status: 400 };
  const refreshToken = await folkpathsDriveToken(userId);
  if (!refreshToken) return { error: "not-connected", status: 400 };
  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const monthFolder = `${date.slice(0, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""}`.trim();
  try {
    const up = await saveBufferToDrive({ refreshToken, name: `${name}.${extOf(mime)}`, base64, mimeType: mime, folderPath: ["Folkpaths Job Sheets", monthFolder, "Advances"] });
    return { url: up.link, fileId: up.id };
  } catch (e) {
    return { error: `drive-failed: ${(e as Error).message.slice(0, 160)}`, status: 502 };
  }
}

// POST (multipart) — record an advance or a return on a job.
// Fields: kind ("advance" | "return"), guideId, date, slotIdx, amount, at (ISO or
// "YYYY-MM-DDTHH:mm"), method, txRef?, peakRef? (advance only), note?, advanceId?
// (return only), file? (transfer slip).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
  const txRef = String(form.get("txRef") || "").slice(0, 120) || null;
  const peakRef = String(form.get("peakRef") || "").slice(0, 60) || null;
  const note = String(form.get("note") || "").slice(0, 500) || null;
  const advanceId = String(form.get("advanceId") || "") || null;
  const file = form.get("file") as unknown as { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;

  if (!(kind === "advance" || kind === "return") || !guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "bad-amount", hint: "Enter a positive amount in baht." }, { status: 400 });
  if (isNaN(at.getTime())) return NextResponse.json({ error: "bad-date" }, { status: 400 });

  // Authorization: operators do everything; the job's own guide may record a RETURN
  // (they made the transfer) but never an advance.
  const opsUser = isOps(session.user.role);
  if (!opsUser && !(kind === "return" && session.user.guideId === guideId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key(guideId, date, slotIdx) }, select: { id: true, ref: true } });
  if (!sheet) return NextResponse.json({ error: "no-sheet", hint: "Save the job sheet first." }, { status: 404 });

  // Accidental double-submit guard: an identical amount recorded on this job within
  // the last minute is almost certainly the same click twice.
  const dupWindow = new Date(Date.now() - 60_000);
  const dup = kind === "advance"
    ? await prisma.guideAdvance.findFirst({ where: { ...key(guideId, date, slotIdx), amount, createdAt: { gte: dupWindow } } })
    : await prisma.guideAdvanceReturn.findFirst({ where: { ...key(guideId, date, slotIdx), amount, createdAt: { gte: dupWindow } } });
  if (dup) return NextResponse.json({ error: "duplicate", hint: "This amount was just recorded — refresh before recording it again." }, { status: 409 });

  let slip: { url: string; fileId: string } | null = null;
  if (file && typeof file.arrayBuffer === "function" && (file.size ?? 0) > 0) {
    const base = sheet.ref || `${guideId}-${date}`;
    const up = await uploadSlip(session.user.id ?? undefined, file, `${base} — ${kind === "advance" ? "advance" : "advance return"} ฿${amount}`, date);
    if ("error" in up) return NextResponse.json({ error: up.error }, { status: up.status });
    slip = up;
  }

  const createdById = session.user.id ?? null;
  if (kind === "advance") {
    const row = await prisma.guideAdvance.create({ data: { ...key(guideId, date, slotIdx), amount, paidAt: at, method, txRef, peakRef, note, slipUrl: slip?.url ?? null, slipFileId: slip?.fileId ?? null, createdById } });
    await audit({ actorId: createdById, actorRole: session.user.role ?? null, action: "advance.recorded", entityType: "GuideAdvance", entityId: row.id, detail: { ref: sheet.ref, guideId, date, slotIdx, amount, method, txRef, slip: !!slip } });
  } else {
    if (advanceId && !(await prisma.guideAdvance.findFirst({ where: { id: advanceId, ...key(guideId, date, slotIdx) } }))) return NextResponse.json({ error: "bad-advance" }, { status: 400 });
    const row = await prisma.guideAdvanceReturn.create({ data: { ...key(guideId, date, slotIdx), advanceId, amount, returnedAt: at, method, txRef, note, slipUrl: slip?.url ?? null, slipFileId: slip?.fileId ?? null, createdById } });
    await audit({ actorId: createdById, actorRole: session.user.role ?? null, action: "advance.return_recorded", entityType: "GuideAdvanceReturn", entityId: row.id, detail: { ref: sheet.ref, guideId, date, slotIdx, amount, method, txRef, slip: !!slip, byGuide: !opsUser } });
  }

  const [advances, returns] = await Promise.all([
    prisma.guideAdvance.findMany({ where: key(guideId, date, slotIdx), orderBy: { paidAt: "asc" } }),
    prisma.guideAdvanceReturn.findMany({ where: key(guideId, date, slotIdx), orderBy: { returnedAt: "asc" } }),
  ]);
  return NextResponse.json({ ok: true, advances, returns });
}

// DELETE { kind, id, guideId, date, slotIdx } — operator/admin only. Removes one
// advance or return row (a mis-entry). Financial rows are audit-logged with their
// full content so nothing disappears silently; any Drive slip file stays.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const kind = String(body?.kind || "");
  const id = String(body?.id || "");
  if (!(kind === "advance" || kind === "return") || !id) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  if (kind === "advance") {
    const row = await prisma.guideAdvance.findUnique({ where: { id }, include: { returns: { select: { id: true } } } });
    if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });
    await prisma.guideAdvance.delete({ where: { id } }); // linked returns keep their money record (advanceId → null)
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "advance.deleted", entityType: "GuideAdvance", entityId: id, detail: { ...row, returns: row.returns.length } });
  } else {
    const row = await prisma.guideAdvanceReturn.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });
    await prisma.guideAdvanceReturn.delete({ where: { id } });
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "advance.return_deleted", entityType: "GuideAdvanceReturn", entityId: id, detail: { ...row } });
  }
  const [advances, returns] = await Promise.all([
    prisma.guideAdvance.findMany({ where: key(String(body?.guideId || ""), String(body?.date || ""), Number(body?.slotIdx)), orderBy: { paidAt: "asc" } }),
    prisma.guideAdvanceReturn.findMany({ where: key(String(body?.guideId || ""), String(body?.date || ""), Number(body?.slotIdx)), orderBy: { returnedAt: "asc" } }),
  ]);
  return NextResponse.json({ ok: true, advances, returns });
}
