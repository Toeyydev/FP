import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

// Guide requests a one-time code to link their LINE account. They add the OA and
// send this code in the chat; the webhook matches it and stores their LINE user id.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const code = randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  await prisma.user.update({ where: { id: session.user.id }, data: { lineLinkCode: code } });
  return NextResponse.json({ ok: true, code, addUrl: process.env.LINE_ADD_FRIEND_URL || process.env.NEXT_PUBLIC_LINE_ADD_URL || null });
}
