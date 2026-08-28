import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { exchangeCode } from "@/lib/google-calendar";

// GET — Google redirects here after consent. Exchange the code for a refresh
// token and store the connection for the signed-in user.
export async function GET(req: NextRequest) {
  const session = await auth();
  const code = req.nextUrl.searchParams.get("code");
  const back = (status: string) => NextResponse.redirect(new URL(`/profile?cal=${status}`, `https://${req.headers.get("x-forwarded-host") || req.headers.get("host") || "ops.folkpaths.com"}`));
  if (!session?.user?.id || !code) return back("error");

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "ops.folkpaths.com";
  try {
    const { refreshToken, email } = await exchangeCode(host, code);
    if (!refreshToken) return back("noToken"); // happens if the user already granted before without prompt=consent
    await prisma.googleCalendar.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, refreshToken: encrypt(refreshToken), email },
      update: { refreshToken: encrypt(refreshToken), email },
    });
    return back("connected");
  } catch {
    return back("error");
  }
}
