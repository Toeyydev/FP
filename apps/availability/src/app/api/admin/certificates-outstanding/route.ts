import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { readOutstandingCertificates } from "@/lib/certificates/outstanding";

export const dynamic = "force-dynamic";

// GET — jobs that still need a certificate in lieu of receipt (lib/certificates/outstanding).
// ADMIN only, like everything about certificates. Read-only.
export async function GET() {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can see certificates in lieu of receipts"] }, { status: 403 });
  return NextResponse.json({ jobs: await readOutstandingCertificates(prisma) }, { headers: { "cache-control": "no-store" } });
}
