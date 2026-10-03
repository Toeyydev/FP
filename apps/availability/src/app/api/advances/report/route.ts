import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { folkpathsDriveToken, googleDriveEnabled, saveBufferToDrive } from "@/lib/google-drive";
import { pdfRendererAvailable, renderPdf } from "@/lib/certificates/pdf";
import { fileAdvancesReport } from "@/lib/advances/report";

export const dynamic = "force-dynamic";

// POST — file the "Company advances" report as a PDF in the company Drive
// (lib/advances/report). Operators and admins. Reads the ledger; writes only the file
// and an audit row.
export async function POST() {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", reasons: ["Google Drive is not configured"] }, { status: 503 });
  if (!pdfRendererAvailable()) return NextResponse.json({ error: "no-renderer", reasons: ["ระบบสร้าง PDF ยังไม่พร้อมใช้งานบนเครื่องนี้"] }, { status: 503 });
  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", reasons: ["Connect the company Google Drive first"] }, { status: 503 });
  try {
    const filed = await fileAdvancesReport(prisma, {
      render: renderPdf,
      save: (o) => saveBufferToDrive({ refreshToken, ...o }),
    }, { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null });
    return NextResponse.json({ ok: true, ...filed });
  } catch (e) {
    return NextResponse.json({ error: "failed", reasons: [`Could not file the report: ${String((e as Error).message).slice(0, 160)}`] }, { status: 502 });
  }
}
