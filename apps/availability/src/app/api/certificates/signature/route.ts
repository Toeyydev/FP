import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { denied } from "@/lib/certificates/denied";
import {
  MAX_SIGNATURE_BYTES, MAX_DIMENSION, MIN_DIMENSION,
} from "@/lib/certificates/signature";
import {
  registerSignature, replacementImpact, retireSignature, signatureHistory,
  SignatureRefused, type Actor,
} from "@/lib/certificates/signature-service";
import { DuplicateSignatureFile } from "@/lib/certificates/signature-drive";
import { attesterListInForce, attesterRefusal } from "@/lib/certificates/attester";
import { checkedDriveAllowlist } from "@/lib/certificates/drive-allowlist";

export const dynamic = "force-dynamic";

// Registering and replacing the signature image that goes on a certificate.
//
// ADMIN only, on the server, on every method. Hiding the screen would not be a control:
// the thing being protected is an image of somebody's handwriting, and anyone who can
// call the endpoint can have it.
//
// GET    — what is on file for a person, and what replacing it would affect
// POST   — register a new version from an uploaded PNG
// DELETE — stand the live one down, keeping every version and its file
//
// Whose signature it is comes from the request, but only ever as a User id an admin
// picked, and the image is only ever read back through the server. No Drive URL, no file
// id and no hash leaves this route to anybody who is not an admin, because nothing
// leaves this route to anybody who is not an admin.

const actorOf = (s: { user?: { id?: string | null; name?: string | null; displayName?: string | null; role?: string | null } } | null): Actor => ({
  id: s?.user?.id ?? "",
  name: (s?.user?.name || s?.user?.displayName || s?.user?.id || "").toString(),
  role: s?.user?.role ?? "",
});

/** Who this is about: the named person, or the admin themselves. */
const subjectOf = (req: NextRequest, session: { user?: { id?: string | null } } | null) =>
  (req.nextUrl.searchParams.get("userId") || session?.user?.id || "").trim();

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "signature.list");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can see attester signatures"] }, { status: 403 });
  }
  const userId = subjectOf(req, session);
  if (!userId) return NextResponse.json({ error: "bad-query", reasons: ["Whose signature?"] }, { status: 400 });

  // Whether the person reading may also change it. Reading is the ADMIN role; changing
  // is narrowed by the attester list, so an admin can legitimately be able to see this
  // page and not to act on it. Saying so up front is better than a refusal after they
  // have chosen a file.
  const me = session?.user?.id ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true, role: true } }) : null;
  const cannotChange = attesterRefusal({ role: me?.role ?? session?.user?.role, email: me?.email });

  // Whether the Drive allowlist names people this company recognises. Checked without
  // calling Drive — the question is about the configured entries, and a misconfiguration
  // should be visible on the settings page rather than first appearing as a refusal
  // halfway through filing a document.
  const allowlist = await checkedDriveAllowlist(null, prisma);

  const [versions, impact, person, admins] = await Promise.all([
    signatureHistory(userId),
    replacementImpact(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, fullName: true, displayName: true, email: true } }),
    // Who a signature may be registered for. Only admins attest, so only admins need one.
    prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true, fullName: true, displayName: true, email: true }, orderBy: { email: "asc" } }),
  ]);

  return NextResponse.json({
    ok: true,
    userId,
    userName: (person?.fullName || person?.displayName || person?.email || userId).trim(),
    active: versions.find((v) => v.active) ?? null,
    versions,
    impact,
    admins: admins.map((a) => ({ id: a.id, name: (a.fullName || a.displayName || a.email || a.id).trim() })),
    mayChange: cannotChange === null,
    cannotChangeReason: cannotChange,
    attesterListInForce: attesterListInForce(),
    driveAllowlist: { verified: allowlist.verified, problems: allowlist.problems },
    limits: { maxBytes: MAX_SIGNATURE_BYTES, minDimension: MIN_DIMENSION, maxDimension: MAX_DIMENSION },
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "signature.register");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can register an attester signature"] }, { status: 403 });
  }
  const actor = actorOf(session);
  if (!actor.id) return NextResponse.json({ error: "forbidden", reasons: ["This session has no user to record as the uploader"] }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const userId = String(form?.get("userId") ?? "").trim() || actor.id;
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "bad-body", reasons: ["Choose a PNG of the signature to upload"] }, { status: 400 });
  }
  // Refused on the size PEAK-style before the bytes are read into memory, so an enormous
  // upload is not turned into an enormous buffer first.
  if (file.size > MAX_SIGNATURE_BYTES) {
    return NextResponse.json({ error: "too-large", reasons: [`The image is ${Math.round(file.size / 1024)} KB, above the ${MAX_SIGNATURE_BYTES / 1024} KB a scanned signature should ever be.`] }, { status: 400 });
  }

  try {
    const out = await registerSignature(userId, Buffer.from(await file.arrayBuffer()), actor);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof SignatureRefused) {
      return NextResponse.json({ error: "not-allowed", reasons: e.reasons, detail: e.reasons.join("\n") }, { status: e.status });
    }
    if (e instanceof DuplicateSignatureFile) {
      return NextResponse.json({
        error: "drive-duplicate",
        reasons: [`Drive holds ${e.fileIds.length} images for this registration, so which one it means is unanswerable. Have someone remove the wrong one before trying again.`],
      }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "signature.retire");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can stand down an attester signature"] }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { userId?: string; reason?: string } | null;
  const userId = (body?.userId ?? "").trim() || (session?.user?.id ?? "");
  try {
    const out = await retireSignature(userId, body?.reason ?? "", actorOf(session));
    return NextResponse.json({ ok: true, retired: out });
  } catch (e) {
    if (e instanceof SignatureRefused) return NextResponse.json({ error: "not-allowed", reasons: e.reasons }, { status: e.status });
    throw e;
  }
}
