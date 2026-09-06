import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decryptBuffer } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET: stream one document attached to a pending guide application.
//
// The applicant has no account yet, so unlike GuideDocument there is no "owner"
// who may fetch this — only an operator or admin reviewing the application. The
// id is a cuid, but that is not the control: the session and role check is.
// Nothing here is ever reachable from a public URL, and the response is marked
// no-store so an ID card does not sit in a shared browser cache.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isOps(session.user.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const doc = await prisma.accessRequestDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "not-found" }, { status: 404 });

  // Opening an applicant's ID card is a deliberate act; record that it happened.
  // The document id and kind only — never the bytes, never the filename's owner.
  await audit({
    actorId: session.user.id ?? null, actorRole: session.user.role ?? null,
    action: "request.document_viewed", entityType: "AccessRequestDocument", entityId: doc.id,
    detail: { kind: doc.kind, requestId: doc.requestId },
  });

  const buf = decryptBuffer(Buffer.from(doc.data));
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": doc.mimeType,
      "content-disposition": `inline; filename="${doc.kind.toLowerCase()}"`,
      "cache-control": "private, no-store",
    },
  });
}
