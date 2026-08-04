import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }

// GET — ops only. Every job sheet previously saved to Drive (audit action
// "jobsheet.drive_saved_pdf" with drive:true), de-duplicated to one entry per
// (guideId,date,slotIdx). Feeds the signature backfill tool.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const logs = await prisma.auditLog.findMany({
    where: { action: "jobsheet.drive_saved_pdf", detail: { path: ["drive"], equals: true } },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  });
  const seen = new Set<string>();
  const sheets: { guideId: string; date: string; slotIdx: number; ref: string }[] = [];
  for (const l of logs) {
    const d = (l.detail ?? {}) as { guideId?: string; date?: string; slotIdx?: number; ref?: string };
    if (!d.guideId || !d.date || typeof d.slotIdx !== "number") continue;
    const k = `${d.guideId}|${d.date}|${d.slotIdx}`;
    if (seen.has(k)) continue;
    seen.add(k);
    sheets.push({ guideId: d.guideId, date: d.date, slotIdx: d.slotIdx, ref: d.ref || `FOLK-BKK-${d.date.replace(/-/g, "")}` });
  }
  sheets.sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx);
  return NextResponse.json({ count: sheets.length, sheets });
}
