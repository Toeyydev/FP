import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { notifyGuide } from "@/lib/booking-import";
import { thb } from "@/lib/jobsheet";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (m: string) => (m.includes("png") ? "png" : m.includes("pdf") ? "pdf" : m.includes("webp") ? "webp" : "jpg");

// POST (multipart) { bonusId, file } — upload a bonus payment slip → Drive, store link.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Connect Google Drive first." }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const bonusId = String(form?.get("bonusId") || "");
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!bonusId || !file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });

  const bonus = await prisma.bonus.findUnique({ where: { id: bonusId } });
  if (!bonus) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect the Folkpaths Google account first." }, { status: 400 });

  const u = await prisma.user.findFirst({ where: { guideId: bonus.guideId }, select: { displayName: true, fullName: true } });
  const guideName = u?.fullName || u?.displayName || bonus.guideId;
  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const mime = file.type || "image/jpeg";
  const monthFolder = `${bonus.period} ${MONTHS[Number(bonus.period.slice(5, 7)) - 1] ?? ""}`.trim();
  const tag = (bonus.ref || `Bonus ${bonusId.slice(-6)}`).replace(/[\\/:*?"<>|]/g, " ").trim();
  const name = `${tag} — ${guideName} — bonus.${extOf(mime)}`;

  let link: string;
  try {
    ({ link } = await saveBufferToDrive({ refreshToken, name, base64, mimeType: mime, folderPath: ["Folkpaths E-slips", monthFolder] }));
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
  await prisma.bonus.update({ where: { id: bonusId }, data: { eslipUrl: link } });
  try {
    await notifyGuide(bonus.guideId, `Your bonus${bonus.reason ? ` (${bonus.reason})` : ""} has been transferred — ${thb(bonus.amount)}. 🎁`, "Bonus transferred \ud83c\udf81", `${thb(bonus.amount)}${bonus.reason ? ` · ${bonus.reason}` : ""}`);
  } catch { /* best-effort */ }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bonus.eslip_uploaded", entityType: "Bonus", entityId: bonusId, detail: { period: bonus.period, guideId: bonus.guideId } });
  return NextResponse.json({ ok: true, link });
}
