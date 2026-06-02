import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

// GET — the signed-in user's recent notifications + unread count.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ unread: 0, items: [] }, { status: 401 });
  const items = await prisma.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, message: true, kind: true, readAt: true, createdAt: true },
  });
  return NextResponse.json({ unread: items.filter((i) => !i.readAt).length, items });
}

// POST — mark all of the user's notifications read.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await prisma.notification.updateMany({ where: { userId: session.user.id, readAt: null }, data: { readAt: new Date() } });
  return NextResponse.json({ ok: true });
}
