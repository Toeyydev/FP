import { NextResponse } from "next/server";
import { emailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";

// Public: is email SENDING configured (SMTP_HOST/USER/PASS set)? No secrets leaked —
// just which vars the running deploy sees, so we can tell missing vs not-deployed.
export function GET() {
  const seen = (k: string) => !!process.env[k];
  return NextResponse.json({
    enabled: emailEnabled,
    sees: {
      SMTP_HOST: seen("SMTP_HOST"), SMTP_PORT: seen("SMTP_PORT"),
      SMTP_USER: seen("SMTP_USER"), SMTP_PASS: seen("SMTP_PASS"),
      EMAIL_FROM: seen("EMAIL_FROM"),
    },
  });
}
