import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { denied } from "@/lib/certificates/denied";
import { fileHash } from "@/lib/certificates/payload";
import { checkFiledDocument } from "@/lib/certificates/service";
import { googleCertificateDrive } from "@/lib/certificates/drive";
import { folkpathsDriveToken } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

// The filed certificate, streamed to an admin who is entitled to read it.
//
// Not a Drive link. A link is access that can be handed on, and the whole arrangement
// around these documents is that they live in a folder nobody was given. So the bytes
// come through this server, and the browser never learns the file id, the folder or the
// URL they came from.
//
// And not on trust. The same verifier that runs before a certificate is relied on for
// money runs here first: exactly one settled file, the attempt on record, the revision
// on record, and bytes that hash to what was filed. Anything it cannot confirm fails
// closed — because the reason to open this document is usually to check it, and a
// document that cannot be verified is the one case where showing it anyway is worst.
//
// Be honest about the limit: an admin who is shown the PDF can save it, forward it or
// print it, and nothing here prevents that. What this prevents is a person who is not an
// admin reading it, and an admin unintentionally passing on access to everything else in
// the folder.

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.pdf");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can open a certificate in lieu of a receipt"] }, { status: 403 });
  }
  const { id } = await ctx.params;

  const cert = await prisma.expenseCertificate.findUnique({ where: { id } });
  if (!cert) return NextResponse.json({ error: "not-found", reasons: ["ไม่พบใบรับรองนี้"] }, { status: 404 });
  if (!cert.driveFileId || !cert.pdfHash) {
    return NextResponse.json({ error: "not-filed", reasons: ["ใบรับรองนี้ยังไม่ได้จัดเก็บไฟล์ จึงยังไม่มี PDF ให้เปิด"] }, { status: 409 });
  }

  // Every question the payment path asks, asked here: one ACTIVE file, the attempt on
  // record, the revision on record, the bytes on record, and a folder still private.
  const check = await checkFiledDocument(cert, {}, session!.user!.id ?? undefined);
  if (!check.ok) {
    return NextResponse.json({ error: check.action ?? "not-verified", reasons: check.reasons }, { status: 409 });
  }

  const token = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!token) return NextResponse.json({ error: "not-connected", reasons: ["ยังไม่ได้เชื่อมต่อ Google Drive"] }, { status: 503 });
  const bytes = await googleCertificateDrive(token)
    .read({ fileId: cert.driveFileId })
    .catch(() => null);

  // Hashed again, on the bytes actually about to be sent. The verifier read the file a
  // moment ago; this is the copy going out.
  if (!bytes || fileHash(bytes) !== cert.pdfHash) {
    return NextResponse.json({
      error: "drive_changed",
      reasons: ["ไฟล์ที่อ่านได้ไม่ตรงกับไฟล์ที่จัดเก็บไว้ จึงไม่แสดงเอกสารนี้ — ให้ตรวจสอบและจัดเก็บใหม่"],
    }, { status: 409 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
      "content-disposition": `inline; filename="${cert.certificateNo}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
