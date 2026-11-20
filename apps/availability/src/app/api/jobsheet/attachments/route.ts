import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { redactRowsForNonAdmin } from "@/lib/certificates/access";
import { classifyBytes, recordClassification } from "@/lib/certificates/receipt-kind";
import { folkpathsDriveToken, googleDriveEnabled, saveBufferToDrive } from "@/lib/google-drive";
import { attachmentsFor, removeAttachment, uploadAttachment, type Actor } from "@/lib/expense-attachments/service";
import { MAX_ATTACHMENT_BYTES } from "@/lib/expense-attachments/validate";

// Files behind Tour Expense rows (lib/expense-attachments/service holds the rules).
//   POST   multipart { guideId, date, slotIdx, rowId | expenseIndex, file, amount?, documentDate? }
//   DELETE { id, reason } — takes the file off the row; the Drive file is kept.

const HINTS: Record<string, string> = {
  "no-sheet": "Save the job sheet first.",
  forbidden: "You can only add files to your own jobs.",
  "row-not-found": "That expense row is no longer on the sheet. Reload and try again.",
  empty: "The file is empty.",
  "too-large": `Max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per file.`,
  "bad-type": "Only JPEG, PNG, WebP or PDF.",
  "type-mismatch": "The file's type does not match its name. Save it again as JPEG, PNG, WebP or PDF.",
  duplicate: "This exact file is already attached to this job.",
  "drive-not-connected": "Google Drive is not connected. Ask the office to connect it.",
  "reason-required": "Say why the file is being removed.",
};

const sheetFor = async (key: { guideId: string; date: string; slotIdx: number }, role: string | null | undefined) => {
  const s = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key } });
  if (!s) return null;
  return isAdmin(role) ? s : { ...s, expenses: redactRowsForNonAdmin(s.expenses as Record<string, unknown>[]) };
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Google Drive is not set up." }, { status: 400 });
  // Refuse anything far over the limit before reading it into memory.
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_ATTACHMENT_BYTES + 64 * 1024) return NextResponse.json({ error: "too-large", hint: HINTS["too-large"] }, { status: 413 });

  const form = await req.formData().catch(() => null);
  const f = form?.get("file") as unknown as { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  const parsed = z.object({
    guideId: z.string().min(1).max(20), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.coerce.number().int().min(0).max(20),
    rowId: z.string().max(40).optional(), expenseIndex: z.coerce.number().int().min(0).max(100).optional(),
    amount: z.coerce.number().min(0).max(10_000_000).optional(), documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).safeParse(Object.fromEntries([...(form?.entries() ?? [])].filter(([k, v]) => k !== "file" && typeof v === "string" && v !== "")));
  if (!parsed.success || !f || typeof f.arrayBuffer !== "function" || (parsed.data.rowId == null && parsed.data.expenseIndex == null)) {
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }
  if ((f.size ?? 0) > MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: "too-large", hint: HINTS["too-large"] }, { status: 400 });
  const bytes = new Uint8Array(await f.arrayBuffer());
  const d = parsed.data;
  const actor: Actor = { id: session.user.id ?? null, role: session.user.role, guideId: session.user.guideId ?? null };
  const key = { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx };

  const r = await uploadAttachment({
    drive: { token: (id) => folkpathsDriveToken(id ?? undefined), save: saveBufferToDrive },
    actor, sheet: key, rowId: d.rowId ?? null, expenseIndex: d.expenseIndex ?? null,
    file: { bytes, mime: f.type, name: f.name }, amountSatang: d.amount != null ? Math.round(d.amount * 100) : null, documentDate: d.documentDate ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, hint: HINTS[r.error] ?? "Upload failed — try again.", existing: r.existing }, { status: r.status });
  // What the file is (transfer slip or receipt), read from the bytes just uploaded; best-effort.
  if (r.attachment.driveFileId) {
    try { await recordClassification(prisma, r.attachment.driveFileId, await classifyBytes(bytes, r.attachment.mimeType, r.attachment.originalName), actor.id); } catch { /* classified later */ }
  }
  const sheet = await sheetFor(key, session.user.role);
  const attachments = sheet ? await attachmentsFor(prisma, sheet, actor) : {};
  return NextResponse.json({ ok: true, retried: r.retried, rowId: r.attachment.expenseRowId, sheet, attachments });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = z.object({ id: z.string().min(1).max(40), reason: z.string().max(500) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const actor: Actor = { id: session.user.id ?? null, role: session.user.role, guideId: session.user.guideId ?? null };
  const r = await removeAttachment({ actor, id: parsed.data.id, reason: parsed.data.reason });
  if (!r.ok) return NextResponse.json({ error: r.error, hint: HINTS[r.error] }, { status: r.status });
  const att = await prisma.expenseAttachment.findUnique({ where: { id: parsed.data.id }, select: { jobSheet: { select: { guideId: true, date: true, slotIdx: true } } } });
  const sheet = att ? await sheetFor(att.jobSheet, session.user.role) : null;
  const attachments = sheet ? await attachmentsFor(prisma, sheet, actor) : {};
  return NextResponse.json({ ok: true, sheet, attachments });
}
