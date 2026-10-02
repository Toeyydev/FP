import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { accountJournal } from "@/lib/advances/account-journal";

export const dynamic = "force-dynamic";

// GET — the account journal of company advances: each movement as its double entry, with
// the PEAK document that carries it or the reason it has none yet. Read-only: it writes
// nothing and calls nothing outside the database (lib/advances/account-journal).
export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await accountJournal(prisma));
}
