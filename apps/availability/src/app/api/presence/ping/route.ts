import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

// Lightweight heartbeat — the app calls this while open so we know who's online.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ ok: false }, { status: 401 });
  await prisma.user.update({ where: { id: session.user.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
