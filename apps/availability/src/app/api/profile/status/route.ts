import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { guideProfileStatus, PROFILE_STATUS_SELECT } from "@/lib/profile";
import { lineLoginEnabled } from "@/lib/line";

// GET — whether the signed-in guide has completed their account details, and
// whether they still need to connect LINE. The app fetches this on load anyway, so
// the LINE prompt costs nothing extra: it belongs on the home screen rather than
// buried in My details, where a guide has to already know to go looking for it.
export async function GET() {
  const session = await auth();
  const off = { complete: true, missing: [], lineLinked: true, lineLoginEnabled: false };
  if (!session?.user?.id) return NextResponse.json(off);
  if (session.user.role !== "GUIDE") return NextResponse.json(off);
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { ...PROFILE_STATUS_SELECT, lineUserId: true },
  });
  return NextResponse.json({
    ...(u ? guideProfileStatus(u) : { complete: true, missing: [] }),
    // "Linked" when unknown, so a lookup failure never nags a guide who is connected.
    lineLinked: u ? !!u.lineUserId : true,
    lineLoginEnabled,
  });
}
