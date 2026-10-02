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
  // Prefer Railway's runtime metadata. NEXT_PUBLIC_BUILD_ID is inlined during
  // `next build`; a cached server-route compilation once left it holding the
  // previous deploy's SHA. The runtime value cannot be frozen in that cache, so
  // an old client sees the new SHA and reloads. Local/non-Railway runs keep the
  // build id fallback and existing behaviour.
  return NextResponse.json(
    { version: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_BUILD_ID || "dev" },
    { headers: { "cache-control": "no-store" } },
  );
}
