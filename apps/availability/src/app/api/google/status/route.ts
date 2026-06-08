import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { googleEnabled } from "@/lib/google-calendar";

// GET — is Google configured + has THIS user connected their calendar?
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ enabled: googleEnabled, connected: false });
  const c = await prisma.googleCalendar.findUnique({ where: { userId: session.user.id }, select: { email: true } }).catch(() => null);
  return NextResponse.json({ enabled: googleEnabled, connected: !!c, email: c?.email ?? null });
}

// DELETE — disconnect this user's Google Calendar.
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await prisma.googleCalendar.deleteMany({ where: { userId: session.user.id } });
  return NextResponse.json({ ok: true });
}
