import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { confirmRegistrationCash } from "@/lib/upsell/walk-in-qr";
import { answerQr, qrActor } from "@/lib/upsell/walk-in-qr-route";

export const dynamic = "force-dynamic";

// POST — the GUIDE of the job received the guest's cash: the sale, booking, guest-list row, custody
// and PEAK receipt event, with the registration CONFIRMED, in one transaction. Same answer on retry.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await qrActor();
  if (a instanceof NextResponse) return a;
  if (a.role !== "GUIDE" || !a.guideId) return NextResponse.json({ error: "forbidden", message: "Only the guide who took the cash records it" }, { status: 403 });
  const id = (await ctx.params).id;
  return answerQr(async () => ({ ok: true, ...(await confirmRegistrationCash(prisma, { userId: a.userId, guideId: a.guideId! }, id)) }));
}
