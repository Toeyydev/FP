import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt, encOpt } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET /api/profile          -> own profile (guide)
// GET /api/profile?userId=  -> any guide's profile (operator/admin)
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const requested = req.nextUrl.searchParams.get("userId");
  const uid = isOps(session.user.role) && requested ? requested : session.user.id;
  if (!uid) return NextResponse.json({ error: "no-user" }, { status: 400 });

  const u = await prisma.user.findUnique({
    where: { id: uid },
    include: { documents: { select: { id: true, kind: true, filename: true, mimeType: true, size: true, uploadedAt: true }, orderBy: { uploadedAt: "desc" } } },
  });
  if (!u) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (!isOps(session.user.role) && u.id !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json({
    id: u.id, guideId: u.guideId, role: u.role, displayName: u.displayName, fullName: u.fullName,
    email: u.email, phone: u.phone, lineId: u.lineId, lineLinked: !!u.lineUserId, languages: u.languages, qualifications: u.qualifications,
    emergencyName: u.emergencyName, emergencyPhone: u.emergencyPhone, emergencyRelation: u.emergencyRelation,
    taxId: decrypt(u.taxId), idCardAddress: decrypt(u.idCardAddress), currentAddress: decrypt(u.currentAddress), bankName: decrypt(u.bankName),
    bankAccountNo: decrypt(u.bankAccountNo), bankAccountName: decrypt(u.bankAccountName), bankBranch: decrypt(u.bankBranch),
    licenseNo: u.licenseNo, signature: decrypt(u.signature),
    documents: u.documents,
    canEdit: true,
    isOperator: isOps(session.user.role),
  });
}

const putSchema = z.object({
  userId: z.string().optional(),
  fullName: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  lineId: z.string().max(80).optional(),
  emergencyName: z.string().max(120).optional(),
  emergencyPhone: z.string().max(40).optional(),
  emergencyRelation: z.string().max(60).optional(),
  licenseNo: z.string().max(60).optional(),
  taxId: z.string().max(60).optional(),
  idCardAddress: z.string().max(600).optional(),
  currentAddress: z.string().max(600).optional(),
  bankName: z.string().max(80).optional(),
  bankAccountNo: z.string().max(60).optional(),
  bankAccountName: z.string().max(120).optional(),
  bankBranch: z.string().max(120).optional(),
});

// PUT /api/profile — guide edits own; operator/admin can edit any via userId. PII encrypted.
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  const uid = isOps(session.user.role) && d.userId ? d.userId : session.user.id;
  if (!uid) return NextResponse.json({ error: "no-user" }, { status: 400 });
  if (!isOps(session.user.role) && uid !== session.user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const data: Record<string, string | null> = {};
  if (d.fullName !== undefined) data.fullName = d.fullName.trim() || null;
  if (d.phone !== undefined) data.phone = d.phone.trim() || null;
  if (d.lineId !== undefined) data.lineId = d.lineId.trim() || null;
  if (d.emergencyName !== undefined) data.emergencyName = d.emergencyName.trim() || null;
  if (d.emergencyPhone !== undefined) data.emergencyPhone = d.emergencyPhone.trim() || null;
  if (d.emergencyRelation !== undefined) data.emergencyRelation = d.emergencyRelation.trim() || null;
  if (d.licenseNo !== undefined) data.licenseNo = d.licenseNo.trim() || null;
  if (d.taxId !== undefined) data.taxId = encOpt(d.taxId);
  if (d.idCardAddress !== undefined) data.idCardAddress = encOpt(d.idCardAddress);
  if (d.currentAddress !== undefined) data.currentAddress = encOpt(d.currentAddress);
  if (d.bankName !== undefined) data.bankName = encOpt(d.bankName);
  if (d.bankAccountNo !== undefined) data.bankAccountNo = encOpt(d.bankAccountNo);
  if (d.bankAccountName !== undefined) data.bankAccountName = encOpt(d.bankAccountName);
  if (d.bankBranch !== undefined) data.bankBranch = encOpt(d.bankBranch);

  await prisma.user.update({ where: { id: uid }, data });
  await audit({ actorId: session.user.id, actorRole: session.user.role, action: "profile.updated", entityType: "User", entityId: uid });
  return NextResponse.json({ ok: true });
}
