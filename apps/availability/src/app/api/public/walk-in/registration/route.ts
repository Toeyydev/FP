import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellWalkInQrEnabled } from "@/lib/upsell/flags";
import { guestRegistrationView } from "@/lib/upsell/walk-in-qr";
import { PUBLIC_HEADERS, off, publicBody } from "@/lib/upsell/walk-in-qr-route";
import { callerKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST { viewToken } — PUBLIC: the guest's OWN registration (the token is in the body, never a
// URL). WAITING / PAID (only once the guide recorded the cash) / ENDED. Unknown → 404.
export async function POST(req: NextRequest) {
  if (!upsellWalkInQrEnabled()) return off();
  if (!rateLimit(callerKey(req.headers, "walkin-status"), 240, 10 * 60_000).ok) return NextResponse.json({ error: "BUSY" }, { status: 429, headers: PUBLIC_HEADERS });
  const body = await publicBody(req);
  if (body instanceof NextResponse) return body;
  const v = await guestRegistrationView(prisma, String((body as { viewToken?: unknown } | null)?.viewToken ?? ""));
  if (!v) return off();
  return NextResponse.json(v, { headers: PUBLIC_HEADERS });
}
