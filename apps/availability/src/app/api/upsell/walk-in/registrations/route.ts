import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guideRegistrations } from "@/lib/upsell/walk-in-qr";
import { answerQr, qrActor } from "@/lib/upsell/walk-in-qr-route";

export const dynamic = "force-dynamic";

// GET ?jobSheetId — this job's guest registrations, for its guide (or Admin) only.
export async function GET(req: NextRequest) {
  const a = await qrActor();
  if (a instanceof NextResponse) return a;
  return answerQr(async () => ({ rows: await guideRegistrations(prisma, a, req.nextUrl.searchParams.get("jobSheetId") ?? "") }), { "Cache-Control": "no-store" });
}
