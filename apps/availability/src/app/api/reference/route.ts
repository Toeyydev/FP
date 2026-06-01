import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOTS } from "@/lib/slots";

// Reference data: the 25 guides + 9 tours + slot definitions. Auth required.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [guides, tours] = await Promise.all([
    prisma.user.findMany({
      where: { role: "GUIDE", guideId: { not: null } },
      select: { guideId: true, displayName: true },
      orderBy: { guideId: "asc" },
    }),
    prisma.tour.findMany({ orderBy: { id: "asc" } }),
  ]);

  return NextResponse.json({ guides, tours, slots: SLOTS });
}
