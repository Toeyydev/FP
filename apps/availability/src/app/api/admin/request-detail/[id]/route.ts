import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { maskTail } from "@/lib/signup-application";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET: the full application for one pending request, including health data.
//
// Separate from the pending list on purpose. The list is a board an operator
// leaves open, often on a shared screen; medical details do not belong there.
// They are read here, one applicant at a time, by someone who chose to look —
// and that choice is audited.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isOps(session.user.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const r = await prisma.accessRequest.findUnique({
    where: { id },
    select: {
      id: true, state: true, createdAt: true,
      fullNameThai: true, fullNameEnglish: true, name: true, nickname: true,
      email: true, phone: true, licenseNo: true, licenseExpiry: true,
      preferredLanguage: true, privacyVersion: true, privacyConsentAt: true,
      nationalId: true, bankName: true, bankAccountName: true, bankAccountNo: true,
      medicalConditionStatus: true, medicalConditionDetails: true, emergencyInstructions: true,
      documents: { select: { id: true, kind: true, mimeType: true, size: true }, orderBy: { uploadedAt: "asc" } },
    },
  });
  if (!r) return NextResponse.json({ error: "not-found" }, { status: 404 });

  // Audited with the request id alone. Recording WHAT was read here would put
  // the medical details straight into the audit log this endpoint exists to
  // keep them out of.
  await audit({
    actorId: session.user.id ?? null, actorRole: session.user.role ?? null,
    action: "request.detail_viewed", entityType: "AccessRequest", entityId: r.id,
  });

  const status = decrypt(r.medicalConditionStatus);
  return NextResponse.json({
    id: r.id, state: r.state, createdAt: r.createdAt,
    fullNameThai: r.fullNameThai, fullNameEnglish: r.fullNameEnglish,
    name: r.name, nickname: r.nickname, email: r.email, phone: r.phone,
    licenseNo: r.licenseNo, licenseExpiry: r.licenseExpiry,
    preferredLanguage: r.preferredLanguage,
    privacyVersion: r.privacyVersion, privacyConsentAt: r.privacyConsentAt,
    // The bank account stays masked even here: an operator verifying a person
    // needs to recognise the account, not to be able to transcribe it. The full
    // number is in the bank book they can open.
    nationalIdMasked: maskTail(decrypt(r.nationalId), 4),
    bankName: decrypt(r.bankName),
    bankAccountName: decrypt(r.bankAccountName),
    bankAccountNoMasked: maskTail(decrypt(r.bankAccountNo), 4),
    // Decrypted only here, only for an operator or admin.
    medicalConditionStatus: status || null,
    medicalConditionDetails: status === "HAS_CONDITION" ? decrypt(r.medicalConditionDetails) || null : null,
    emergencyInstructions: decrypt(r.emergencyInstructions) || null,
    documents: r.documents,
  });
}
