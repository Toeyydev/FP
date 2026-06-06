import { NextResponse } from "next/server";
import { emailEnabled } from "@/lib/email";

// Public: is email SENDING configured (SMTP_HOST/USER/PASS set)? No secrets leaked —
// just whether the calendar invites / sign-up emails will actually go out.
export function GET() {
  return NextResponse.json({ enabled: emailEnabled });
}
