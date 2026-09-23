import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Expense } from "@/lib/jobsheet";
import type { ExpenseWithEvidence } from "@/lib/reimbursement-evidence";

// Loading the certificate states a payment needs in order to judge its rows.
//
// `evidenceState` stays pure — it takes a row and a map and returns an answer, with no
// database behind it. This is the one place that fills the map in, so a caller that
// forgets leaves rows unproven instead of assuming a certificate is in force.

/** Certificate ids named by waivers on these rows. */
export function certificateIdsIn(expenses: readonly Expense[] | null | undefined): string[] {
  const ids = new Set<string>();
  for (const e of expenses ?? []) {
    const id = ((e as ExpenseWithEvidence).evidenceWaiver?.certificateId ?? "").trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** id → status, for every certificate these rows lean on. */
export async function certificateStatuses(
  rowsets: readonly (readonly Expense[])[],
  db: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<Record<string, string>> {
  const ids = [...new Set(rowsets.flatMap((rows) => certificateIdsIn(rows)))];
  if (!ids.length) return {};
  const found = await db.expenseCertificate.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  return Object.fromEntries(found.map((c) => [c.id, c.status]));
}
