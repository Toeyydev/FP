import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideAdvanceSummary } from "@/lib/guide-advance";

// GET ?date&slotIdx — what the token's guide still owes on money the company
// advanced them for that job: paid out, spent from it, returned, and what is left,
// with the same status the operator's job sheet shows.
//
// Read-only. Recording a return stays where it is (/api/jobsheet/advance), which
// already accepts one from the job's own guide.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || "";
  const slotIdx = Number(url.searchParams.get("slotIdx") ?? "-1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0) {
    return NextResponse.json({ error: "bad-query" }, { status: 400 });
  }

  return NextResponse.json(await guideAdvanceSummary(a.user.guideId, date, slotIdx));
}
