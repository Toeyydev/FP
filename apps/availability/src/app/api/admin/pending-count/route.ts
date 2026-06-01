import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

// Lightweight count for the operator board's "Accounts" badge.
export async function GET() {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "OPERATOR" && role !== "ADMIN") return NextResponse.json({ count: 0 }, { status: 403 });
  const count = await prisma.accessRequest.count({ where: { state: "PENDING" } });
  return NextResponse.json({ count });
}
