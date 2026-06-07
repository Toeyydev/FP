import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt, decryptBuffer } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const KIND_LABEL: Record<string, string> = { ID_CARD: "id-card", BANK_BOOK: "bank-book", GUIDE_LICENSE: "guide-license", OTHER: "other" };
const ext = (mime: string, name: string) => (mime.includes("pdf") ? "pdf" : mime.includes("png") ? "png" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : (name.split(".").pop() || "bin"));

// GET ?userId= — download ALL of one guide's documents + a profile summary, as a
// single ZIP. Owner guide (own) or operator/admin (any).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const requested = req.nextUrl.searchParams.get("userId");
  const uid = isOps(session.user.role) && requested ? requested : session.user.id;
  if (!uid) return NextResponse.json({ error: "no-user" }, { status: 400 });
  if (!isOps(session.user.role) && uid !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const u = await prisma.user.findUnique({ where: { id: uid }, include: { documents: { orderBy: { uploadedAt: "asc" } } } });
  if (!u) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const zip = new JSZip();
  const seen: Record<string, number> = {};
  for (const d of u.documents) {
    const label = KIND_LABEL[d.kind] ?? "doc";
    const n = (seen[label] = (seen[label] ?? 0) + 1);
    const fname = `${label}${n > 1 ? `-${n}` : ""}.${ext(d.mimeType, d.filename)}`;
    zip.file(fname, decryptBuffer(Buffer.from(d.data)));
  }

  // A plain-text profile summary so the export is a complete per-guide record.
  const L = (k: string, v: string | string[] | null | undefined) => {
    const s = Array.isArray(v) ? v.join(", ") : v;
    return `${k}: ${s && String(s).trim() ? s : "—"}`;
  };
  const profile = [
    `FOLKPATHS — GUIDE RECORD`,
    L("Guide ID", u.guideId), L("Name", u.fullName || u.displayName), L("Email", u.email), L("Phone", u.phone),
    L("LINE ID", u.lineId), L("Languages", u.languages), L("Qualifications", u.qualifications),
    `\n[Emergency]`, L("Contact", u.emergencyName), L("Phone", u.emergencyPhone), L("Relationship", u.emergencyRelation),
    `\n[Identity & address]`, L("Tax ID", decrypt(u.taxId)), L("ID-card address", decrypt(u.idCardAddress)), L("Current address", decrypt(u.currentAddress)),
    `\n[Bank]`, L("Bank", decrypt(u.bankName)), L("Account no.", decrypt(u.bankAccountNo)), L("Account name", decrypt(u.bankAccountName)), L("Branch", decrypt(u.bankBranch)),
    `\n[Documents] ${u.documents.length} file(s)`,
  ].join("\n");
  zip.file("profile.txt", profile);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await audit({ actorId: session.user.id, actorRole: session.user.role, action: "documents.exported", entityType: "User", entityId: uid, detail: { count: u.documents.length } });
  const base = (u.guideId || u.displayName || "guide").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${base}-folkpaths.zip"`, "cache-control": "private, no-store" },
  });
}
