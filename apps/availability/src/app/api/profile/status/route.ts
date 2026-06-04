import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { guideProfileStatus } from "@/lib/profile";

// GET — whether the signed-in guide has completed their account details.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ complete: true, missing: [] });
  if (session.user.role !== "GUIDE") return NextResponse.json({ complete: true, missing: [] });
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { fullName: true, phone: true, taxId: true, currentAddress: true, idCardAddress: true, bankName: true, bankAccountNo: true, bankAccountName: true, emergencyName: true, emergencyPhone: true },
  });
  return NextResponse.json(u ? guideProfileStatus(u) : { complete: true, missing: [] });
}
