import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellWalkInQrEnabled } from "@/lib/upsell/flags";
import { guestCancel } from "@/lib/upsell/walk-in-qr";
import { PUBLIC_HEADERS, answerQr, off, publicBody } from "@/lib/upsell/walk-in-qr-route";
import { callerKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST { viewToken } — PUBLIC: the guest withdraws their WAITING registration. A paid one is refused.
export async function POST(req: NextRequest) {
  if (!upsellWalkInQrEnabled()) return off();
  if (!rateLimit(callerKey(req.headers, "walkin-cancel"), 20, 10 * 60_000).ok) return NextResponse.json({ error: "BUSY" }, { status: 429, headers: PUBLIC_HEADERS });
  const body = await publicBody(req);
  if (body instanceof NextResponse) return body;
  return answerQr(() => guestCancel(prisma, String((body as { viewToken?: unknown } | null)?.viewToken ?? "")), PUBLIC_HEADERS);
}
