import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { guideProfileStatus, PROFILE_STATUS_SELECT } from "@/lib/profile";

// GET — whether the signed-in guide has completed their account details.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ complete: true, missing: [] });
  if (session.user.role !== "GUIDE") return NextResponse.json({ complete: true, missing: [] });
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: PROFILE_STATUS_SELECT,
  });
  return NextResponse.json(u ? guideProfileStatus(u) : { complete: true, missing: [] });
}
