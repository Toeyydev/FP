import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { todayD, ymd } from "@/lib/dates";

// GET — the signed-in user's recent notifications + unread count. Notifications
// about a tour that has already happened are hidden (every date they reference is
// before today), so the bell stays focused on upcoming/current work.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ unread: 0, items: [] }, { status: 401 });
  const raw = await prisma.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, message: true, kind: true, readAt: true, createdAt: true, offerId: true },
  });

  const today = ymd(todayD());
  const offerIds = [...new Set(raw.map((n) => n.offerId).filter((x): x is string => !!x))];
  const offers = offerIds.length ? await prisma.jobOffer.findMany({ where: { id: { in: offerIds } }, select: { id: true, date: true } }) : [];
  const offerDate = new Map(offers.map((o) => [o.id, o.date]));
  // Past = references at least one tour date and they're ALL before today (so
  // general/dateless and any future-dated notifications stay visible).
  const isPast = (n: (typeof raw)[number]) => {
    const dates: string[] = [];
    const od = n.offerId ? offerDate.get(n.offerId) : undefined;
    if (od) dates.push(od);
    const found = n.message.match(/\d{4}-\d{2}-\d{2}/g);
    if (found) dates.push(...found);
    return dates.length > 0 && dates.every((d) => d < today);
  };

  const items = raw.filter((n) => !isPast(n)).slice(0, 30).map(({ offerId, ...rest }) => rest);
  return NextResponse.json({ unread: items.filter((i) => !i.readAt).length, items });
}

// POST — mark all of the user's notifications read.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await prisma.notification.updateMany({ where: { userId: session.user.id, readAt: null }, data: { readAt: new Date() } });
  return NextResponse.json({ ok: true });
}

// DELETE — clear all of the user's notifications.
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await prisma.notification.deleteMany({ where: { userId: session.user.id } });
  return NextResponse.json({ ok: true });
}
