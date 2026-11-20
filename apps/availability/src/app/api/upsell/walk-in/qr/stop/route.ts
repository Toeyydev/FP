import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stopQr } from "@/lib/upsell/walk-in-qr";
import { answerQr, qrActor } from "@/lib/upsell/walk-in-qr-route";

export const dynamic = "force-dynamic";

// POST { jobSheetId } — stop the job's guest QR; unpaid registrations from it end, paid ones stay.
export async function POST(req: NextRequest) {
  const a = await qrActor();
  if (a instanceof NextResponse) return a;
  const b = (await req.json().catch(() => null)) as { jobSheetId?: unknown } | null;
  return answerQr(() => stopQr(prisma, a, String(b?.jobSheetId ?? "")));
}
