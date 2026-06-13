import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { googleDriveEnabled, saveBufferToDrive } from "@/lib/google-drive";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

// POST (multipart) { period, guideId, file } — upload a bank payment slip (e-slip)
// as evidence, push it straight to Google Drive (Folkpaths E-slips / <month>), and
// store the Drive link on the guide's monthly payroll row. Operator/admin only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Connect Google Drive first." }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const period = String(form?.get("period") || "");
  const guideId = String(form?.get("guideId") || "");
  const file = form?.get("file");
  if (!/^\d{4}-\d{2}$/.test(period) || !guideId || !(file instanceof File)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });

  const conn = await prisma.googleCalendar.findUnique({ where: { userId: session!.user!.id ?? "" } }).catch(() => null);
  if (!conn) return NextResponse.json({ error: "not-connected", hint: "Connect Google Drive first." }, { status: 400 });

  const u = await prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } });
  const guideName = u?.fullName || u?.displayName || guideId;
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const mime = file.type || "image/jpeg";
  const monthFolder = `${period} ${MONTHS[Number(period.slice(5, 7)) - 1] ?? ""}`.trim();
  const name = `${guideId} ${guideName} ${period}.${extOf(mime)}`;

  let link: string;
  try {
    ({ link } = await saveBufferToDrive({ refreshToken: decrypt(conn.refreshToken), name, base64, mimeType: mime, folderPath: ["Folkpaths E-slips", monthFolder] }));
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  await prisma.payrollStatus.upsert({
    where: { guideId_period: { guideId, period } },
    create: { guideId, period, status: "pending", eslipUrl: link },
    update: { eslipUrl: link },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.eslip_uploaded", entityType: "PayrollStatus", detail: { period, guideId } });
  return NextResponse.json({ ok: true, link });
}

// DELETE { period, guideId } — clear the e-slip link (the file stays in Drive).
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const period = String(body?.period || ""), guideId = String(body?.guideId || "");
  if (!/^\d{4}-\d{2}$/.test(period) || !guideId) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  await prisma.payrollStatus.updateMany({ where: { guideId, period }, data: { eslipUrl: null } });
  return NextResponse.json({ ok: true });
}
