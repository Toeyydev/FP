import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMobile } from "@/lib/mobile-auth";
import { SLOT_COUNT } from "@/lib/slots";
import { guideMonthAvailability, setGuideAvailability } from "@/lib/guide-availability";

// The times a guide has told FolkOPS they cannot work.
//
// GET ?month=YYYY-MM — the token guide's own month, as { days: { [day]: boolean[] } }
// where `true` on a slot means they are NOT available then.
//
// PUT { date, slots } — replace one day. Send the whole array, including any slot
// that already carries a job: those are locked, and a change to one is refused
// rather than dropping work the guide has already accepted.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const month = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  return NextResponse.json({ month, days: await guideMonthAvailability(a.user.guideId, month) });
}

export async function PUT(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slots: z.array(z.boolean()).length(SLOT_COUNT),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const r = await setGuideAvailability({ guideId: a.user.guideId, userId: a.user.id, ...parsed.data });
  if (!r.ok) return NextResponse.json({ error: r.error, ...("slots" in r ? { slots: r.slots } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true });
}
