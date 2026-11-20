import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentQr, openQr } from "@/lib/upsell/walk-in-qr";
import { answerQr, qrActor } from "@/lib/upsell/walk-in-qr-route";

export const dynamic = "force-dynamic";

// GET ?jobSheetId — the job's guest QR (guide of the job, or Admin): its URL and a QR drawn here
// (no outside service), or why there is none. POST { jobSheetId } — a new QR; the old one stops.
export async function GET(req: NextRequest) {
  const a = await qrActor();
  if (a instanceof NextResponse) return a;
  return answerQr(() => currentQr(prisma, a, req.nextUrl.searchParams.get("jobSheetId") ?? ""), { "Cache-Control": "no-store" });
}
export async function POST(req: NextRequest) {
  const a = await qrActor();
  if (a instanceof NextResponse) return a;
  const b = (await req.json().catch(() => null)) as { jobSheetId?: unknown } | null;
  return answerQr(() => openQr(prisma, a, String(b?.jobSheetId ?? "")), { "Cache-Control": "no-store" });
}
