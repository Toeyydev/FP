import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { authenticateMobile } from "@/lib/mobile-auth";
import { assignedTourId } from "@/lib/guide-lifecycle";
import { MAX_EXPENSE_LINES } from "@/lib/guide-expenses";
import { receiptDriveName } from "@/lib/jobsheet";
import { uploadJobFile, type SlipFile } from "@/lib/advance-slip";

// POST (multipart) { date, slotIdx, index, description, file } — one receipt for
// one line of the token's guide's expense report.
//
// The app used to let a guide attach a receipt, show it ticked, and then send the
// report without it; the operator never saw the evidence and the guide believed
// they had sent it. This files the receipt in the company Drive, beside the ones
// operators upload (Folkpaths Job Sheets / <month> / Receipts), and hands back the
// fields that line of /api/mobile/expenses already carries — so the receipt
// travels with the claim it supports.
//
// It writes nothing to the job sheet itself. A guide's report lines are not the
// operator's rows, so there is no row here to attach it to; the expense report
// that follows is what records it.
export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const form = await req.formData().catch(() => null);
  const date = String(form?.get("date") ?? "");
  const slotIdx = Number(form?.get("slotIdx"));
  const index = Number(form?.get("index") ?? 0);
  const description = String(form?.get("description") ?? "").slice(0, 120);
  // Duck-typed: the File global is not defined in the Node server runtime.
  const file = form?.get("file") as unknown as SlipFile | null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0
    || !Number.isInteger(index) || index < 0 || index >= MAX_EXPENSE_LINES
    || !file || typeof file.arrayBuffer !== "function") {
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }

  const guideId = a.user.guideId;
  if (!(await assignedTourId(guideId, date, slotIdx))) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true, ref: true } });
  const up = await uploadJobFile({
    userId: a.user.id, file, date, folder: "Receipts",
    name: (ext) => receiptDriveName({ ref: sheet?.ref, guideId, date, index, description, ext, from: "guide" }),
  });
  if ("error" in up) return NextResponse.json({ error: up.error }, { status: up.status });

  const receiptAt = new Date().toISOString();
  await audit({
    actorId: a.user.id, actorRole: a.user.role,
    action: "jobsheet.guide_receipt_uploaded", entityType: "JobSheet", entityId: sheet?.id,
    detail: { guideId, date, slotIdx, index, description },
  });

  return NextResponse.json({
    receiptUrl: up.url,
    receiptFileId: up.fileId,
    receiptName: (file.name || "receipt").slice(0, 200),
    receiptAt,
    receiptBy: a.user.id,
  });
}
