import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { BankTxRefused, bankTxRefusal, type BankAdmin } from "@/lib/bank-transactions";

// Shared by app/api/bank-transactions/*: who may act, and how a refusal is answered.

/** The signed-in ADMIN, re-read from the database (a demoted user's old session does nothing). */
export async function sessionAdmin(session: { user?: { id?: string | null; role?: string | null } } | null): Promise<BankAdmin | null> {
  const id = session?.user?.id;
  if (!id || session?.user?.role !== "ADMIN") return null;
  const me = await prisma.user.findUnique({ where: { id }, select: { role: true, state: true } });
  return me?.role === "ADMIN" && me.state === "ACTIVE" ? { actorId: id, actorRole: "ADMIN" } : null;
}

export const forbidden = () => NextResponse.json({ error: "forbidden", reasons: ["Only an admin corrects bank transfers"] }, { status: 403 });

/** A refusal the person can act on → 409 with the reason; anything else is a bug and is thrown. */
export function refusalResponse(e: unknown) {
  if (e instanceof BankTxRefused) return NextResponse.json({ error: "refused", reasons: [e.message] }, { status: 409 });
  const r = bankTxRefusal(e);
  if (r) return NextResponse.json({ error: "refused", reasons: [r] }, { status: 409 });
  throw e;
}
