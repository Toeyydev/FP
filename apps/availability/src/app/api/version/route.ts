import { NextResponse } from "next/server";

// The version (git SHA) the running server is on. The client compares this to
// the version it loaded with and refreshes when a newer one is deployed.
export const dynamic = "force-dynamic";

export function GET() {
  // Same build id the client baked in (inlined at build time), so they always
  // agree within a deploy and only differ when a new version ships.
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_BUILD_ID || "dev" },
    { headers: { "cache-control": "no-store" } },
  );
}
