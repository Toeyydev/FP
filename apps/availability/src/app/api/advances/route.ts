import { uploadSlip } from "@/lib/advance-slip";
import { NextRequest, NextResponse } from "next/server";
import { advanceSyncStates } from "@/lib/advances/peak-sync";
import { peakLinksFor } from "@/lib/advances/peak-link";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { canViewFinance, isOps } from "@/lib/roles";
import { issueAdvance } from "@/lib/advances/service";
import { advanceStatus, fromSatang, outstandingSatang } from "@/lib/advances/rules";
import { bangkokToday } from "@/lib/payments-v2/rules";
import { advanceBody } from "@/lib/advances/request-schema";

export const dynamic = "force-dynamic";

// GET ?guideId=&status=open — the advances and what each one still owes.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") ?? "";
  const only = req.nextUrl.searchParams.get("status") ?? "";
  const rows = await prisma.guideAdvance.findMany({
    where: { ...(guideId ? { guideId } : {}) },
    orderBy: [{ advanceDate: "desc" }, { advanceNo: "desc" }],
    take: 500,
    select: {
      id: true, advanceNo: true, guideId: true, jobNo: true, advanceDate: true, accountingPeriod: true,
      amountSatang: true, settledSatang: true, purpose: true, method: true, txRef: true, slipUrl: true,
      reversedAt: true, reversalReason: true, peakDocumentNo: true,
    },
  });
  const sync = await advanceSyncStates(prisma, rows.map(r => `ADVANCE:${r.id}`));
  const links = await peakLinksFor(prisma, "ADVANCE", rows.map((r) => r.id));
  const advances = rows
    .map((r) => ({
      ...r, peakSync: sync.get(`ADVANCE:${r.id}`) ?? null, peakLink: links.get(r.id) ?? null, amount: fromSatang(r.amountSatang), settled: fromSatang(r.settledSatang),
      outstanding: fromSatang(outstandingSatang(r)), status: advanceStatus(r),
    }))
    .filter((r) => (only === "open" ? r.status === "OPEN" || r.status === "PARTIALLY_SETTLED" : true));
  return NextResponse.json({ advances });
}

// POST — record money the company transferred to a guide. Operators only: money going
// out to a guide is the company's to record, never the guide's.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const form = req.headers.get("content-type")?.includes("multipart/form-data") ? await req.formData().catch(() => null) : null;
  const raw = form ? { ...Object.fromEntries(form), amount: Number(form.get("amount")) } : await req.json().catch(() => null);
  const parsed = advanceBody.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });

  const file = form?.get("file");
  if (!parsed.data.jobNo?.trim()) return NextResponse.json({ error: "Choose a Job No. for this advance" }, { status: 400 });
  if (!parsed.data.bankAccount?.trim()) return NextResponse.json({ error: "Choose the company bank account used for this transfer" }, { status: 400 });
  if (!parsed.data.bankRef?.trim()) return NextResponse.json({ error: "Enter the bank transfer reference" }, { status: 400 });
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Attach the transfer slip" }, { status: 400 });
  const sheet = await prisma.jobSheet.findFirst({ where: { ref: parsed.data.jobNo, guideId: parsed.data.guideId }, select: { id: true } });
  if (!sheet) return NextResponse.json({ error: "Choose an existing Job No. for this guide before uploading" }, { status: 400 });
  const uploaded = await uploadSlip(session!.user!.id, file, `${parsed.data.jobNo} — advance`, parsed.data.advanceDate);
  if ("error" in uploaded) return NextResponse.json({ error: uploaded.error }, { status: uploaded.status });
  const slip = uploaded;
  const result = await issueAdvance(prisma, {
    ...parsed.data, slipUrl: slip?.url, slipFileId: slip?.fileId, today: bangkokToday(),
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true, advance: result.advance });
}
