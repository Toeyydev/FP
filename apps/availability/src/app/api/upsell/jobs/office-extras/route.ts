import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cashActor, only } from "@/lib/upsell/cash-access";
import { officeExtras } from "@/lib/upsell/sales";

export const dynamic = "force-dynamic";

// GET ?jobSheetId — what the office may record for the guide on this job (Job Sheet › Extras cash).
export async function GET(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  const id = req.nextUrl.searchParams.get("jobSheetId") ?? "";
  if (!id) return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  return NextResponse.json({ extras: await officeExtras(prisma, id), canRecord: a.role === "ADMIN" || a.role === "OPERATOR" }, { headers: { "cache-control": "no-store" } });
}
