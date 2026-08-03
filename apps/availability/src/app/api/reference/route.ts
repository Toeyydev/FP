import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOTS } from "@/lib/slots";

// Reference data: the 25 guides + 9 tours + slot definitions. Auth required.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Only operators/admins get the full guide roster; a guide doesn't need
  // (and shouldn't see) anyone else's record.
  const isOps = session.user.role === "OPERATOR" || session.user.role === "ADMIN";
  const guides = isOps
    ? await prisma.user.findMany({
        where: { role: "GUIDE", guideId: { not: null } },
        // state + offerBlocked let the board hide off/ineligible guides from the
        // assign & offer surfaces (mirrors availableGuides()).
        select: { guideId: true, displayName: true, phone: true, state: true, offerBlocked: true },
        orderBy: { guideId: "asc" },
      })
    : [];
  const tours = await prisma.tour.findMany({ orderBy: { id: "asc" } });

  return NextResponse.json({ guides, tours, slots: SLOTS });
}
