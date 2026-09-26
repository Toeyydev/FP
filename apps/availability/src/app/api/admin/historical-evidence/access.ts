import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

// Who may use the historical evidence campaign: ADMIN, checked on every request.
//
// The session says what role someone had when they signed in; the database says what
// role they have now. Both have to say ADMIN. GUIDE, OPERATOR and ACCOUNTANT get 403 from
// every endpoint, including the ones that only read — the page carries amounts, payers
// and certificate numbers across every historical job.

export type AdminCheck = { ok: true; userId: string } | { ok: false; status: 401 | 403 };

export async function requireAdmin(): Promise<AdminCheck> {
  const session = await auth();
  const id = session?.user?.id ?? null;
  if (!id) return { ok: false, status: 401 };
  if (session?.user?.role !== "ADMIN") return { ok: false, status: 403 };
  const me = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (me?.role !== "ADMIN") return { ok: false, status: 403 };
  return { ok: true, userId: id };
}

/**
 * A refused WRITE is recorded; a refused read is not. Reading must leave the database
 * exactly as it was — for anyone — so a GET never writes, not even to say no.
 */
export async function deniedWrite(endpoint: string): Promise<void> {
  const session = await auth().catch(() => null);
  await audit({
    actorId: session?.user?.id ?? null, actorRole: session?.user?.role ?? null,
    action: "historical_evidence.access_denied", entityType: "JobSheet",
    detail: { endpoint },
  }).catch(() => {});
}
