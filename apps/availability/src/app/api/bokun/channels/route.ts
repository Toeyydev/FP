import { NextResponse } from "next/server";
import { bokunProbe, bokunApiEnabled } from "@/lib/bokun-api";

// TEMP diagnostic — probe candidate Bokun endpoints to discover the account's
// booking channel(s). No secrets returned, just status + a short snippet.
export async function GET() {
  if (!bokunApiEnabled) return NextResponse.json({ error: "not-configured" });
  const candidates: [string, string, unknown?][] = [
    ["GET", "/booking-channel.json/find-all"],
    ["GET", "/booking-channel.json/list"],
    ["GET", "/booking-channel.json"],
    ["GET", "/account.json/get-current"],
    ["GET", "/vendor.json/list"],
    ["GET", "/restapi/v2.0/booking-channel"],
  ];
  const results = [];
  for (const [m, p, b] of candidates) results.push(await bokunProbe(m, p, b));
  return NextResponse.json({ results });
}
