import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideAdvanceSummary, recordAdvanceReturn } from "@/lib/guide-advance";
import { assignedTourId } from "@/lib/guide-lifecycle";
import { MAX_SLIP_BYTES } from "@/lib/advance-slip";

// GET ?date&slotIdx — what the token's guide still owes on money the company
// advanced them for that job: paid out, spent from it, returned, and what is left,
// with the same status the operator's job sheet shows.
//
// POST (multipart) { date, slotIdx, amount, method?, txRef?, note?, advanceId?, slip? }
// records the guide sending unspent cash back — the same row, in the same place,
// as an operator typing it on the job sheet. A guide can only ever record a
// RETURN: money going out to them is the company's to record.
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

export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const date = String(form.get("date") || "");
  const slotIdx = Number(form.get("slotIdx"));
  const amount = Number(String(form.get("amount") || "").replace(/[,\s]/g, ""));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const slip = form.get("slip") as unknown as { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (slip && (slip.size ?? 0) > MAX_SLIP_BYTES) return NextResponse.json({ error: "too-large" }, { status: 400 });

  const guideId = a.user.guideId;
  if (!(await assignedTourId(guideId, date, slotIdx))) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const r = await recordAdvanceReturn({
    guideId, date, slotIdx, amount,
    method: String(form.get("method") || "bank").slice(0, 24) || "bank",
    txRef: String(form.get("txRef") || "").slice(0, 120) || null,
    note: String(form.get("note") || "").slice(0, 500) || null,
    advanceId: String(form.get("advanceId") || "") || null,
    slipFile: slip,
    actorId: a.user.id,
    actorRole: a.user.role,
    byGuide: true,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.hint ? { hint: r.hint } : {}) }, { status: r.status });

  // Answer with the balance as it now stands, so the screen needs no second call.
  return NextResponse.json({ ok: true, id: r.id, slip: r.slip, summary: await guideAdvanceSummary(guideId, date, slotIdx) });
}
