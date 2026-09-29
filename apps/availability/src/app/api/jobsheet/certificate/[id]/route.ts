import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { CertificateRefused, linkCertificate, attestCertificate, uploadCertificate, voidCertificate, type Actor } from "@/lib/certificates/service";
import { denied } from "@/lib/certificates/denied";

export const dynamic = "force-dynamic";

// Moving one certificate along: certify it, file it, put it to use, or withdraw it.
//
// Admin only, and the approver is the session — the body carries an action and, when
// withdrawing, a reason. There is no field here for a name, an id, a role or a time,
// because none of those may come from a browser.
//
// "certify" here means รับรองเอกสารทางอิเล็กทรอนิกส์: an authenticated person accepting
// the document, recorded with their name, their role, the moment, and an audit row. It
// is not a cryptographic signature and nothing in this file should call it one.

const bodyZ = z.object({
  action: z.enum(["attest", "upload", "link", "void"]),
  reason: z.string().max(500).optional(),
});

const actorOf = (s: { user?: { id?: string | null; name?: string | null; displayName?: string | null; role?: string | null } } | null): Actor => ({
  id: s?.user?.id ?? "",
  name: (s?.user?.name || s?.user?.displayName || s?.user?.id || "").toString(),
  role: s?.user?.role ?? "",
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.action");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can certify or withdraw a certificate in lieu of a receipt"] }, { status: 403 });
  }
  const { id } = await ctx.params;
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });

  const actor = actorOf(session);
  if (!actor.id) return NextResponse.json({ error: "forbidden", reasons: ["This session has no user to record as the approver"] }, { status: 403 });

  try {
    const { action, reason } = parsed.data;
    const cert =
      action === "attest" ? await attestCertificate(id, actor)
      : action === "upload" ? await uploadCertificate(id, actor)
      : action === "link" ? await linkCertificate(id, actor)
      : await voidCertificate(id, reason ?? "", actor);
    return NextResponse.json({
      ok: true,
      certificate: {
        id: cert.id, certificateNo: cert.certificateNo, status: cert.status,
        attestedByName: cert.attestedByName, attestedByRole: cert.attestedByRole, attestedAt: cert.attestedAt,
        driveUrl: cert.driveUrl, pdfHash: cert.pdfHash, payloadHash: cert.payloadHash,
        linkedAt: cert.linkedAt, voidedAt: cert.voidedAt, voidReason: cert.voidReason,
      },
    });
  } catch (e) {
    if (e instanceof CertificateRefused) {
      return NextResponse.json({ error: e.status === 404 ? "not-found" : "not-allowed", reasons: e.reasons, detail: e.reasons.join("\n") }, { status: e.status });
    }
    throw e;
  }
}
