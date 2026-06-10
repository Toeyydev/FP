import { NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // always read env at request time, never cache

// Public diagnostic: are the Bokun API keys present at RUNTIME? Reports only
// presence + length (never the secret values), so we can tell missing vs typo vs
// empty vs not-restarted. Also lists any env var names starting with BOKUN_.
export function GET() {
  const a = process.env.BOKUN_ACCESS_KEY || "";
  const s = process.env.BOKUN_SECRET_KEY || "";
  const bokunVarNames = Object.keys(process.env).filter((k) => k.startsWith("BOKUN")).sort();
  return NextResponse.json({
    enabled: !!(a && s),
    accessKey: { present: !!a, length: a.length },
    secretKey: { present: !!s, length: s.length },
    bokunVarNamesSeen: bokunVarNames,
  });
}
