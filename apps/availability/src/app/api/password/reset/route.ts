import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { revokeAllForUser } from "@/lib/sessionTokens";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function POST(req: NextRequest) {
  const parsed = z.object({ token: z.string().min(10), password: z.string().min(8) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(parsed.data.token) } });
  if (!row || row.consumedAt || row.expiresAt < new Date()) return NextResponse.json({ error: "invalid" }, { status: 400 });

  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: bcrypt.hashSync(parsed.data.password, 10) } }),
    prisma.passwordReset.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
    prisma.passwordReset.deleteMany({ where: { userId: row.userId, consumedAt: null } }),
  ]);
  // Reset invalidates existing sessions.
  await revokeAllForUser(row.userId);
  await audit({ actorId: row.userId, action: "password.reset", entityType: "User", entityId: row.userId });
  return NextResponse.json({ ok: true });
}
