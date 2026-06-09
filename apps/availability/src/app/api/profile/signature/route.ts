import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { encOpt } from "@/lib/crypto";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { dataUri, userId? } — save a guide's signature image (a small PNG/JPEG
// data-URI), stored AES-encrypted. Guide saves own; operator can set any.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = z.object({
    userId: z.string().optional(),
    dataUri: z.string().regex(/^data:image\/(png|jpeg|jpg);base64,/).max(400_000), // ~300KB image
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const uid = isOps(session.user.role) && parsed.data.userId ? parsed.data.userId : session.user.id;
  if (!uid) return NextResponse.json({ error: "no-user" }, { status: 400 });
  if (!isOps(session.user.role) && uid !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  await prisma.user.update({ where: { id: uid }, data: { signature: encOpt(parsed.data.dataUri) } });
  return NextResponse.json({ ok: true });
}

// DELETE { userId? } — remove the stored signature.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const uid = isOps(session.user.role) && body?.userId ? body.userId : session.user.id;
  if (!uid) return NextResponse.json({ error: "no-user" }, { status: 400 });
  if (!isOps(session.user.role) && uid !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await prisma.user.update({ where: { id: uid }, data: { signature: null } });
  return NextResponse.json({ ok: true });
}
