import { NextResponse } from "next/server";
import { startSyncLoop } from "@/lib/sync-loop";

// The version (git SHA) the running server is on. The client compares this to
// the version it loaded with and refreshes when a newer one is deployed.
export const dynamic = "force-dynamic";

export function GET() {
  // Boot the background sync loop on the first poll after a deploy/restart
  // (idempotent — it only ever starts once per server process). This keeps Bokun
  // bookings + cancellations current without depending on the webhook or anyone
  // having the app open.
  startSyncLoop();
  // Same build id the client baked in (inlined at build time), so they always
  // agree within a deploy and only differ when a new version ships.
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_BUILD_ID || "dev" },
    { headers: { "cache-control": "no-store" } },
  );
}
