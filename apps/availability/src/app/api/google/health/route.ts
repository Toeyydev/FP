import { NextResponse } from "next/server";
import { googleEnabled } from "@/lib/google-calendar";

// Public: is the Google OAuth client configured? (no secrets leaked)
export function GET() {
  return NextResponse.json({ enabled: googleEnabled });
}
