import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decryptBuffer } from "@/lib/crypto";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET: stream the decrypted document (owner guide or operator/admin only).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const doc = await prisma.guideDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (!isOps(session.user.role) && doc.userId !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const buf = decryptBuffer(Buffer.from(doc.data));
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": doc.mimeType, "content-disposition": `inline; filename="${doc.filename}"`, "cache-control": "private, no-store" },
  });
}

// DELETE: remove a document (owner guide or operator/admin).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const doc = await prisma.guideDocument.findUnique({ where: { id }, select: { userId: true } });
  if (!doc) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (!isOps(session.user.role) && doc.userId !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await prisma.guideDocument.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
