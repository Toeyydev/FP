import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { denied } from "@/lib/certificates/denied";
import { activeSignatureBytes } from "@/lib/certificates/signature-service";

export const dynamic = "force-dynamic";

// The registered signature image itself, for an admin to look at.
//
// Served by this server from the private file, rather than by handing out a Drive link.
// A link is a thing that can be forwarded, pasted into a chat and opened by whoever ends
// up with it; a response is not. So an admin sees the image and never learns where it
// lives, which is also why there is no file id or hash anywhere in this answer.
//
// Not cached by anything in between. The image is the one asset here worth stealing, and
// a proxy holding a copy of it is a copy nobody is watching.

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
      "cache-control": "no-store, private",
      "content-disposition": "inline",
      // It is an image and nothing else, whatever the bytes might be mistaken for.
      "x-content-type-options": "nosniff",
    },
  });
}
