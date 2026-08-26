import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { getContacts, peakEnabled, sanitizePeakError } from "@/lib/peak-api";

export const dynamic = "force-dynamic";

// GET ?q= — the contacts (guides) that already exist in PEAK, so an operator links
// a guide to one instead of pasting an opaque id.
//
// READ-ONLY: lists contacts, creates nothing. Creating a contact from our side is
// exactly what the stored peakContactId exists to prevent.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!peakEnabled) {
    return NextResponse.json({ ok: false, contacts: [], error: "PEAK is not connected (credentials or user token missing)" }, { status: 503 });
  }

  const q = req.nextUrl.searchParams.get("q") || undefined;
  let res;
  try {
    res = await getContacts({ searchText: q, limit: 200 });
  } catch (e) {
    return NextResponse.json({ ok: false, contacts: [], error: sanitizePeakError(e) }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ ok: false, contacts: [], error: res.desc ?? "PEAK rejected the contact request", peakCode: res.code ?? null }, { status: 502 });
  }

  const contacts = res.contacts ?? [];
  if (!contacts.length) {
    return NextResponse.json({
      ok: false, contacts: [],
      error: q
        ? `No PEAK contact matched "${q}".`
        : "PEAK returned no contacts. If your guide list is not empty, this is a parsing problem — send this message to support.",
      peakCode: res.code ?? null,
    }, { status: 502 });
  }
  return NextResponse.json({ ok: true, contacts });
}
