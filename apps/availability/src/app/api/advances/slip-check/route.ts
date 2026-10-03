import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { MAX_SLIP_BYTES } from "@/lib/advance-slip";
import { runSlipCheck } from "@/lib/advances/slip-check";
import { duplicateTransferBody, liveAdvanceForTransfer } from "@/lib/advances/tx-ref";

export const dynamic = "force-dynamic";

// POST (multipart) { file, guideId, amount, advanceDate, bankRef } — what the slip shows,
// compared with what is being typed (lib/advances/slip-match), and whether this transfer
// is already recorded. Writes nothing and uploads nothing: the record routes run the same
// check again on the bytes they are given, and only theirs counts.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const file = form.get("file");
  const guideId = String(form.get("guideId") || "").trim();
  const amountRaw = Number(String(form.get("amount") || "").replace(/[,\s]/g, ""));
  const advanceDate = String(form.get("advanceDate") || "");
  const bankRef = String(form.get("bankRef") || "").slice(0, 120) || null;
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "bad-body", reasons: ["Attach the transfer slip"] }, { status: 400 });
  if (file.size > MAX_SLIP_BYTES) return NextResponse.json({ error: "too-large" }, { status: 400 });
  if (!guideId) return NextResponse.json({ error: "bad-body", reasons: ["Choose the guide first"] }, { status: 400 });

  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(advanceDate) ? advanceDate : null;
  const check = await runSlipCheck(prisma, file, guideId, { txRef: bankRef, amount, advanceDate: date });
  const existing = await liveAdvanceForTransfer(prisma, bankRef ?? check.slip?.transactionId);
  return NextResponse.json({
    check,
    duplicate: existing ? duplicateTransferBody(existing, { amount, advanceDate: date }) : null,
    isAdmin: session!.user!.role === "ADMIN",
  });
}
