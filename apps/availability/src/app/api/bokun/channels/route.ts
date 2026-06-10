import { NextResponse } from "next/server";
import { bokunProbe, bokunApiEnabled } from "@/lib/bokun-api";

// TEMP diagnostic — probe candidate Bokun endpoints to discover the account's
// booking channel(s). No secrets returned, just status + a short snippet.
export async function GET() {
  if (!bokunApiEnabled) return NextResponse.json({ error: "not-configured" });
  const candidates: [string, string, unknown?][] = [
    ["POST", "/booking-channel.json/search", {}],
    ["GET", "/booking-channel.json/find-all"],
    ["GET", "/booking-channel.json/find"],
    ["GET", "/restapi/v2.0/booking-channels"],
    ["GET", "/restapi/v2.0/booking-channel"],
    ["GET", "/sales-channel.json/list"],
    ["GET", "/booking.json/booking-channels"],
    ["GET", "/inventory.json/booking-channels"],
    ["POST", "/booking.json/booking-channel-search", {}],
    ["GET", "/checkout.json/booking-channels"],
    ["GET", "/booking-channel-list.json"],
    ["GET", "/booking-channel.json/get-current"],
  ];
  const results = [];
  for (const [m, p, b] of candidates) results.push(await bokunProbe(m, p, b));
  // Surface only the ones that didn't 404 first, for easy reading.
  results.sort((a, b) => (a.status === 404 ? 1 : 0) - (b.status === 404 ? 1 : 0));
  return NextResponse.json({ results });
}
