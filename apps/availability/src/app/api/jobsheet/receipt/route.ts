import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { receiptDriveName, type Expense } from "@/lib/jobsheet";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");
const OK_TYPES = /^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/i;

// POST (multipart) { guideId, date, slotIdx, expenseIndex, file } — operator/admin only.
// Attaches a supporting receipt to ONE expense line: uploads it to the company Drive
// (Folkpaths Job Sheets / <month> / Receipts) and records the Drive link + metadata on
// that expense row. Reuses the SAME Drive store as job sheets + e-slips — no second
// storage system. Callers save the sheet first, so the row index is stable.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Connect Google Drive first." }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const guideId = String(form?.get("guideId") || "");
  const date = String(form?.get("date") || "");
  const slotIdx = Number(form?.get("slotIdx"));
  const expenseIndex = Number(form?.get("expenseIndex"));
  // Duck-type the file: the File global isn't defined in the Node server runtime.
  const file = form?.get("file") as unknown as { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0) || !(expenseIndex >= 0) || !file || typeof file.arrayBuffer !== "function") {
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }
  const mime = file.type || "image/jpeg";
  if (!OK_TYPES.test(mime)) return NextResponse.json({ error: "bad-type", hint: "Upload an image or a PDF." }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });

  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const sheet = await prisma.jobSheet.findUnique({ where: key, select: { id: true, ref: true, expenses: true } });
  if (!sheet) return NextResponse.json({ error: "no-sheet", hint: "Save the sheet first." }, { status: 404 });
  const expenses = (Array.isArray(sheet.expenses) ? sheet.expenses : []) as Expense[];
  if (expenseIndex >= expenses.length) return NextResponse.json({ error: "bad-index" }, { status: 400 });

  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect the Folkpaths Google account first." }, { status: 400 });

  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const monthFolder = `${date.slice(0, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""}`.trim();
  const name = receiptDriveName({ ref: sheet.ref, guideId, date, index: expenseIndex, description: expenses[expenseIndex]?.description, ext: extOf(mime) });

  let up: { id: string; link: string };
  try {
    up = await saveBufferToDrive({ refreshToken, name, base64, mimeType: mime, folderPath: ["Folkpaths Job Sheets", monthFolder, "Receipts"] });
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  const at = new Date().toISOString();
  const next = expenses.map((e, i) => (i === expenseIndex
    ? { ...e, receiptUrl: up.link, receiptFileId: up.id, receiptName: (file.name || name).slice(0, 200), receiptAt: at, receiptBy: session!.user!.id ?? undefined }
    : e));
  const updated = await prisma.jobSheet.update({ where: key, data: { expenses: next } });

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "jobsheet.receipt_uploaded", entityType: "JobSheet", entityId: sheet.id,
    detail: { guideId, date, slotIdx, ref: sheet.ref, expenseIndex, description: expenses[expenseIndex]?.description ?? "", name: file.name ?? name },
  });
  return NextResponse.json({ ok: true, link: up.link, sheet: updated });
}

// DELETE { guideId, date, slotIdx, expenseIndex } — detach a receipt from an expense
// row (clears the fields; the file stays in Drive, mirroring the e-slip DELETE).
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  const expenseIndex = Number(body?.expenseIndex);
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0) || !(expenseIndex >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const sheet = await prisma.jobSheet.findUnique({ where: key, select: { id: true, ref: true, expenses: true } });
  if (!sheet) return NextResponse.json({ error: "no-sheet" }, { status: 404 });
  const expenses = (Array.isArray(sheet.expenses) ? sheet.expenses : []) as Expense[];
  if (expenseIndex >= expenses.length) return NextResponse.json({ error: "bad-index" }, { status: 400 });

  const next = expenses.map((e, i) => {
    if (i !== expenseIndex) return e;
    const r = { ...e };
    delete r.receiptUrl; delete r.receiptFileId; delete r.receiptName; delete r.receiptAt; delete r.receiptBy;
    return r;
  });
  const updated = await prisma.jobSheet.update({ where: key, data: { expenses: next } });
  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "jobsheet.receipt_removed", entityType: "JobSheet", entityId: sheet.id,
    detail: { guideId, date, slotIdx, ref: sheet.ref, expenseIndex },
  });
  return NextResponse.json({ ok: true, sheet: updated });
}
