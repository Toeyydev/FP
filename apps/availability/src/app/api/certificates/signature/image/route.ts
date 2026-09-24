import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { denied } from "@/lib/certificates/denied";
import { activeSignatureBytes } from "@/lib/certificates/signature-service";

export const dynamic = "force-dynamic";

// The registered signature image itself, for an admin to look at.
//
// Be exact about what this buys, because it is easy to overclaim. Once these bytes reach
// a browser they can be saved, forwarded, screenshotted or printed — nothing here
// prevents any of that, and no arrangement of HTTP could. An authorised person who wants
// a copy of the image has one the moment they are shown it.
//
// What it does buy is narrower and still worth having:
//
//   the Drive location is never disclosed  — no file id, no folder, no shareable URL, so
//                                            access cannot be passed on by pasting a link
//   the endpoint is closed                 — a non-admin gets 403 and no bytes at all
//   nothing keeps a copy on the way        — private, no-store, so it does not settle in
//                                            a shared cache or a proxy nobody is watching
//
// The bytes are also never embedded in HTML or JSON. An <img> pointing here keeps the
// image out of page source, out of API responses, and out of anything that logs bodies.

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "signature.image");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can see an attester signature"] }, { status: 403 });
  }
  const userId = (req.nextUrl.searchParams.get("userId") || session?.user?.id || "").trim();
  if (!userId) return NextResponse.json({ error: "bad-query", reasons: ["Whose signature?"] }, { status: 400 });

  const found = await activeSignatureBytes(userId, session!.user!.id ?? "");
  if (!found) {
    // One answer for "none registered", "not filed" and "the bytes no longer match".
    // Which of those it is belongs on the settings screen, which says so in words; a
    // 404 from an image endpoint is not the place to explain it.
    return NextResponse.json({ error: "not-found", reasons: ["There is no signature image on file for this person that can be shown."] }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(found.bytes), {
    headers: {
      "content-type": "image/png",
      "content-length": String(found.bytes.length),
      // private: never a shared cache. no-store: not written to disk by the browser
      // either, so it does not outlive the tab in someone's profile directory.
      "cache-control": "private, no-store",
      pragma: "no-cache",
      "content-disposition": "inline",
      // It is an image and nothing else, whatever the bytes might be mistaken for.
      "x-content-type-options": "nosniff",
    },
  });
}
