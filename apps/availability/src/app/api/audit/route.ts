import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Finance-relevant audit actions only — the accounting trail, not the whole
// operational log (offers, bookings, logins etc. stay out of this view).
const FINANCE_PREFIXES = ["payment", "payroll", "pay.", "bonus", "payment_batch", "review", "jobsheet.approved", "jobsheet.unapproved", "jobsheet.receipt"];

// GET ?before=<ISO>&q=<text> — newest-first page of the finance audit trail
// (100 rows; pass `before` = last row's createdAt to page further). Read-only,
// finance roles. Actor ids are resolved to display names server-side.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const before = req.nextUrl.searchParams.get("before");
  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();

  const rows = await prisma.auditLog.findMany({
    where: {
      OR: FINANCE_PREFIXES.map((p) => ({ action: { startsWith: p } })),
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, actorId: true, actorRole: true, action: true, entityType: true, entityId: true, detail: true, createdAt: true },
  });

  // Resolve actor display names in one query (never expose emails here).
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const users = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.displayName ?? null : null);

  let out = rows.map((r) => ({
    id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId,
    actor: nameOf(r.actorId) ?? (r.actorRole === "SYSTEM_WORKER" ? "System" : r.actorRole ?? "—"),
    actorRole: r.actorRole, detail: r.detail, at: r.createdAt,
  }));
  // Text filter applied after the page fetch — cheap, and the log is bounded per page.
  if (q) out = out.filter((r) => `${r.action} ${r.actor} ${JSON.stringify(r.detail ?? "")}`.toLowerCase().includes(q));

  return NextResponse.json({ rows: out, nextBefore: rows.length === 100 ? rows[rows.length - 1].createdAt : null });
}
