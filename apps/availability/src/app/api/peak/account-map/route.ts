import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { canViewFinance } from "@/lib/roles";
import { audit } from "@/lib/audit";
import {
  ACCOUNTING_CATEGORIES,
  accountChartReady,
  categoryStatus,
  isAccountingCategory,
  missingRequired,
  type AccountingCategory,
} from "@/lib/peak-accounts";

export const dynamic = "force-dynamic";

async function loadMappings() {
  const rows = await prisma.peakAccountMapping.findMany({
    select: { folkopsCategory: true, peakAccountCode: true, peakAccountName: true, isActive: true, updatedAt: true, updatedById: true },
  });
  return rows;
}

// GET — the mapping table as the UI renders it: every category (even unmapped
// ones), its saved account, and its status. Finance roles may read.
export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = await loadMappings();
  const byKey = new Map(rows.map((r) => [r.folkopsCategory, r]));

  return NextResponse.json({
    // Driven by the catalogue, not by what happens to be in the table, so a
    // category that was never saved still appears — as unmapped.
    categories: ACCOUNTING_CATEGORIES.map((c) => {
      const m = byKey.get(c.key);
      return {
        key: c.key, label: c.label, th: c.th, example: c.example, required: c.required, note: c.note ?? null,
        peakAccountCode: m?.peakAccountCode ?? null,
        peakAccountName: m?.peakAccountName ?? null,
        status: categoryStatus(c.key, m ?? null),
        updatedAt: m?.updatedAt ?? null,
      };
    }),
    accountChartReady: accountChartReady(rows),
    missingRequired: missingRequired(rows),
  });
}

const bodyZ = z.object({
  mappings: z.array(z.object({
    folkopsCategory: z.string().min(1).max(40),
    // Empty string clears the mapping — the escape hatch when the wrong account
    // was chosen. A code is what PEAK books against, so clearing it un-maps the
    // category regardless of what name is sent.
    peakAccountCode: z.string().max(40).nullish(),
    peakAccountName: z.string().max(160).nullish(),
  })).min(1).max(20),
});

// POST { mappings: [{ folkopsCategory, peakAccountCode, peakAccountName }] }
//
// Saves the chart mapping. Operator/admin only, audited. This writes ONLY our own
// mapping table — it makes no PEAK call and creates no accounting document.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  // Reject unknown categories rather than silently storing a typo that would
  // never match anything at posting time.
  const unknown = parsed.data.mappings.map((m) => m.folkopsCategory).filter((k) => !isAccountingCategory(k));
  if (unknown.length) return NextResponse.json({ error: "unknown-category", detail: unknown.join(", ") }, { status: 400 });

  const before = await loadMappings();
  const beforeByKey = new Map(before.map((r) => [r.folkopsCategory, r]));
  const changed: { category: string; from: string | null; to: string | null }[] = [];

  for (const m of parsed.data.mappings) {
    const key = m.folkopsCategory as AccountingCategory;
    const code = (m.peakAccountCode ?? "").trim() || null;
    // A name without a code is not a mapping, just a label — drop it so the row
    // cannot look configured when it books nowhere.
    const name = code ? ((m.peakAccountName ?? "").trim() || null) : null;
    const prev = beforeByKey.get(key)?.peakAccountCode ?? null;
    if (prev !== code) changed.push({ category: key, from: prev, to: code });

    // Unique on folkopsCategory, so repeated saves update in place rather than
    // accumulating duplicate rows for the same category.
    await prisma.peakAccountMapping.upsert({
      where: { folkopsCategory: key },
      create: { folkopsCategory: key, peakAccountCode: code, peakAccountName: name, updatedById: session!.user!.id ?? null },
      update: { peakAccountCode: code, peakAccountName: name, updatedById: session!.user!.id ?? null },
    });
  }

  const after = await loadMappings();
  const ready = accountChartReady(after);

  if (changed.length) {
    await audit({
      actorId: session!.user!.id ?? null,
      actorRole: session!.user!.role ?? null,
      action: "peak.account_map_saved",
      entityType: "PeakAccountMapping",
      // Account codes are PEAK record references, not credentials — logging which
      // account a category was pointed at is the whole value of the trail.
      detail: { changed, accountChartReady: ready },
    });
  }

  return NextResponse.json({ ok: true, accountChartReady: ready, missingRequired: missingRequired(after) });
}
