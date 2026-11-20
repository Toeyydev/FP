import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { fileEvidence, type Upload } from "@/lib/evidence-file";
import { bangkokToday } from "@/lib/payments-v2/rules";
import { forbidden, sessionAdmin } from "@/lib/bank-transactions-route";

export const dynamic = "force-dynamic";

// POST (multipart: file) — ADMIN: file the slip or statement a bank correction rests on; returns
// the evidence id the correction then cites.
export async function POST(req: NextRequest) {
  const admin = await sessionAdmin(await auth());
  if (!admin) return forbidden();
  const form = await req.formData().catch(() => null);
  const r = await fileEvidence(form?.get("file") as unknown as Upload | null, { actorId: admin.actorId, date: bangkokToday(), label: "bank correction evidence", evidenceType: "BANK_STATEMENT" });
  return r.ok ? NextResponse.json({ ok: true, evidenceId: r.evidenceId, url: r.url }) : NextResponse.json({ error: "evidence", reasons: [r.reason] }, { status: r.status });
}
