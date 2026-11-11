import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST — retired. A guide used to press "I received it", which stamped
// GuideAdvance.acknowledgedAt. Owner decision 2026-11-11: a Company ADV is read-only
// for a guide; they change nothing on it. Acknowledgements already recorded stay as
// they are (history is kept), but no new one can be written, by anyone.
export async function POST() {
  return NextResponse.json(
    { error: "removed", reasons: ["Acknowledging an advance has been removed. The advance is read-only for guides."] },
    { status: 410 },
  );
}
