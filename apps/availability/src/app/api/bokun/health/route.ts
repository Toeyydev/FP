import { NextResponse } from "next/server";
import { bokunApiEnabled } from "@/lib/bokun-api";

// Public: are the Bokun API keys configured on the server? (no secrets leaked —
// just whether BOKUN_ACCESS_KEY + BOKUN_SECRET_KEY are present.)
export function GET() {
  return NextResponse.json({ enabled: bokunApiEnabled });
}
