import { NextResponse } from "next/server";

// The version (git SHA) the running server is on. The client compares this to
// the version it loaded with and refreshes when a newer one is deployed.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { version: process.env.RAILWAY_GIT_COMMIT_SHA || "dev" },
    { headers: { "cache-control": "no-store" } },
  );
}
