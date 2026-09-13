import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideProfileStatus, PROFILE_STATUS_SELECT } from "@/lib/profile";

// GET — what FolkOPS holds about the token's guide, for the app's Profile screen.
//
// The screen used to state "Licence: Verified" and "Bank details: On file" as
// fixed text, which said nothing about the account in front of it. These are the
// real values.
//
// The bank account number is masked to its last four digits: enough for a guide to
// recognise which account they are paid into, without a full account number
// sitting in the app.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const u = await prisma.user.findUnique({
    where: { guideId: a.user.guideId },
    select: { guideId: true, displayName: true, fullName: true, email: true, phone: true, licenseNo: true, bankName: true, bankAccountNo: true, bankAccountName: true, ...PROFILE_STATUS_SELECT },
  });
  if (!u) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const accountNo = decrypt(u.bankAccountNo) ?? "";
  const status = guideProfileStatus(u as Record<string, unknown>);

  return NextResponse.json({
    guideId: u.guideId,
    displayName: u.displayName,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    // The licence number as recorded. FolkOPS holds no expiry date for it, so the
    // app must not imply one.
    licenseNo: u.licenseNo,
    bank: {
      name: decrypt(u.bankName),
      accountName: decrypt(u.bankAccountName),
      last4: accountNo ? accountNo.replace(/\D/g, "").slice(-4) : null,
    },
    // What still has to be filled in — the same gate that refuses a save on
    // /api/mobile/availability, so the app can say exactly what is missing.
    // `fields` carries the keys, so the Thai app names them in Thai.
    profile: status,
  });
}
