import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { decryptBuffer } from "@/lib/crypto";

// GET: stream a stored payment slip (image/PDF). Finance roles only
// (operator/admin/accountant) — e-slips are payment evidence on the money screens.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || !canViewFinance(session.user.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.eslip.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const buf = decryptBuffer(Buffer.from(row.data));
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": row.mimeType,
      "content-disposition": `inline; filename="${(row.filename || "e-slip").replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}
