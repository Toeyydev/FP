import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { upsellEnabled } from "./flags";
import { SettlementError } from "./settlement";

// Who may act on Extras cash (PR4), checked on every request. While UPSELL_ENABLED is off the
// routes do not exist (404). The session's role (and guide code) must match the database now.
// GUIDE acts on their own job only (the service checks the job); ADMIN decides; OPERATOR and
// ACCOUNTANT read only — refused on every write, on the server.

export type CashActor = { userId: string; role: "GUIDE" | "ADMIN" | "OPERATOR" | "ACCOUNTANT"; guideId: string | null };

export async function cashActor(): Promise<CashActor | NextResponse> {
  if (!upsellEnabled()) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const session = await auth();
  const id = session?.user?.id ?? null;
  if (!id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session?.user?.role as string | undefined;
  const me = await prisma.user.findUnique({ where: { id }, select: { role: true, state: true, guideId: true } });
  if (!me || me.state !== "ACTIVE" || me.role !== role || !["GUIDE", "ADMIN", "OPERATOR", "ACCOUNTANT"].includes(role ?? "")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (role === "GUIDE" && !me.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return { userId: id, role: role as CashActor["role"], guideId: me.guideId };
}

export const only = (a: CashActor, ...roles: CashActor["role"][]) => roles.includes(a.role) ? null : NextResponse.json({ error: "forbidden", reasons: ["Read only for your role"] }, { status: 403 });

/** A refusal the person can act on → its status and code; anything else is a bug and is thrown. */
export async function answer<T>(fn: () => Promise<T>) {
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    if (e instanceof SettlementError) return NextResponse.json({ error: e.code, reasons: [e.message] }, { status: e.status });
    throw e;
  }
}

export const body = async (req: Request) => (await req.json().catch(() => null)) as Record<string, unknown> | null;
