import { NextResponse } from "next/server";
import { pushEnabled } from "@/lib/push";

// Public: is push SENDING configured (VAPID_PRIVATE_KEY set)? No secrets leaked.
export function GET() {
  return NextResponse.json({ enabled: pushEnabled });
}
