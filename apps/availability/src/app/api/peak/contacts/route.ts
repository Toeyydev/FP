import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getContacts, peakEnabled, sanitizePeakError } from "@/lib/peak-api";
import { suggestPeakContact, type ContactSuggestion } from "@/lib/peak-contact-suggest";

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

  // Mask before anything leaves the server. The picker exists so an operator can
  // RECOGNISE the right contact, which the Thai name, the PEAK contact code and
  // the last digits of a tax number do. The full tax number identifies a legal
  // person and is never needed to make that choice, so it never reaches the
  // browser — the raw value stops here.
  const mask = (v?: string) => {
    const t = (v ?? "").trim();
    if (!t) return null;
    return t.length <= 4 ? "••••" : `${"•".repeat(Math.min(t.length - 4, 8))}${t.slice(-4)}`;
  };
  const contacts = (res.contacts ?? []).map((c) => ({
    id: c.id,
    name: c.name,                    // Thai, as PEAK holds it — what the operator matches on
    code: c.code ?? null,            // PEAK contact code, for verification
    taxNumberMasked: mask(c.taxNumber),
    // PEAK's contact list does not return bank details, so there are none to show.
    // Reported explicitly rather than left as a silently missing field.
    bankMasked: null as string | null,
  }));
  if (!contacts.length) {
    return NextResponse.json({
      ok: false, contacts: [],
      error: q
        ? `No PEAK contact matched "${q}".`
        : "PEAK returned no contacts. If your guide list is not empty, this is a parsing problem — send this message to support.",
      peakCode: res.code ?? null,
    }, { status: 502 });
  }
  // The suggestion is computed HERE, never in the browser. Matching on a tax number
  // needs PEAK's FULL number, and that value is masked above precisely so it never
  // leaves the server. Client-side matching would mean either shipping the raw number
  // or comparing four digits — and a four-digit match can name the wrong legal person
  // on an accounting document.
  let suggestion: ContactSuggestion | null = null;
  const guideId = req.nextUrl.searchParams.get("guideId")?.trim();
  if (guideId) {
    const g = await prisma.user.findUnique({
      where: { guideId },
      select: { guideId: true, fullName: true, displayName: true, taxId: true },
    });
    if (g?.guideId) {
      suggestion = suggestPeakContact(
        { guideId: g.guideId, legalName: g.fullName || g.displayName, taxId: decrypt(g.taxId) },
        (res.contacts ?? []).map((c) => ({ id: c.id, name: c.name, code: c.code ?? null, taxNumber: c.taxNumber ?? null })),
      );
    }
  }

  return NextResponse.json({
    ok: true,
    contacts,
    // Which contact to offer, and why — the explanation carries only the last four
    // digits, never the number itself.
    suggestion,
    // So the UI can say why no bank column is shown, instead of looking broken.
    bankDetailsAvailable: false,
  });
}
