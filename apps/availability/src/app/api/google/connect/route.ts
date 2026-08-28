import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { googleEnabled, authUrl } from "@/lib/google-calendar";
import { PUBLIC_HOST } from "@/lib/site";

// GET — start the Google Calendar OAuth flow (redirects to Google's consent).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(new URL("/start", req.url));
  if (!googleEnabled) return NextResponse.json({ error: "not-configured", hint: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on Railway." }, { status: 400 });
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || PUBLIC_HOST;
  return NextResponse.redirect(authUrl(host, session.user.id));
}
