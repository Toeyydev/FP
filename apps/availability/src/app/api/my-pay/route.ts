import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { guidePay } from "@/lib/guide-pay";

// GET ?all=1 — the signed-in guide's own pay, grouped by month. Defaults to the last
// 12 months; ?all=1 returns their full history. Each tour: net fee (after WHT) +
// reimbursable expenses, its paid status, and the bank slip — so the guide can check
// the transfer matches the job sheet (and open the sheet itself from the app).
// The rules live in lib/guide-pay, shared with FolkOPS Mobile (/api/mobile/my-pay).
export async function GET(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!session?.user || !guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const all = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json(await guidePay(guideId, { all }));
}
