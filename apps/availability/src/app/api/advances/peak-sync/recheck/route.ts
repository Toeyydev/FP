import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { mayReconcile, recheckPosted } from "@/lib/advances/peak-reconcile";

export const dynamic = "force-dynamic";

// POST — read-only re-check of every Company ADV journal FolkOPS holds as in PEAK (sent or linked)
// against PEAK as it is now (lib/advances/peak-reconcile). Writes nothing anywhere; flags only.
// POST (not GET) because each call reads PEAK once per journal. ADMIN / ACCOUNTANT only.
export async function POST() {
  const session = await auth();
  if (!mayReconcile(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await recheckPosted(prisma);
  const count = (r: string) => rows.filter((x) => x.result === r).length;
  return NextResponse.json({ checkedAt: new Date().toISOString(), summary: { total: rows.length, match: count("MATCH"), mismatch: count("MISMATCH"), notFound: count("NOT_FOUND"), unchecked: count("UNCHECKED") }, rows });
}
