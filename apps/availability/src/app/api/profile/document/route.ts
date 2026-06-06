import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { encryptBuffer } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const KINDS = ["ID_CARD", "BANK_BOOK", "GUIDE_LICENSE", "OTHER"];
const MAX = 12 * 1024 * 1024; // 12 MB
const ALLOWED = ["application/pdf", "image/jpeg", "image/jpg", "image/png"]; // PDF, JPG, PNG only

// POST multipart: file, kind, optional userId (operator). Stored AES-encrypted in the DB.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad-form" }, { status: 400 });
  const kind = String(form.get("kind") || "");
  const file = form.get("file");
  const requested = form.get("userId") ? String(form.get("userId")) : null;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: "bad-kind" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "no-file" }, { status: 400 });
  const mime = (file.type || "").toLowerCase();
  if (!ALLOWED.includes(mime)) return NextResponse.json({ error: "bad-type" }, { status: 415 });

  const uid = isOps(session.user.role) && requested ? requested : session.user.id;
  if (!uid) return NextResponse.json({ error: "no-user" }, { status: 400 });
  if (!isOps(session.user.role) && uid !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX) return NextResponse.json({ error: "too-large" }, { status: 413 });

  const doc = await prisma.guideDocument.create({
    data: { userId: uid, kind, filename: file.name || "upload", mimeType: file.type || "application/octet-stream", size: buf.length, data: new Uint8Array(encryptBuffer(buf)) },
  });
  await audit({ actorId: session.user.id, actorRole: session.user.role, action: "document.uploaded", entityType: "User", entityId: uid, detail: { kind, docId: doc.id } });
  return NextResponse.json({ ok: true, id: doc.id });
}
