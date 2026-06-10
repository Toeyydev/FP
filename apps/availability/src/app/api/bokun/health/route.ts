import { NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // always read env at request time, never cache

// Public diagnostic: are the Bokun API keys present at RUNTIME? Reports only
// presence + length (never the secret values), so we can tell missing vs typo vs
// empty vs not-restarted. Also lists any env var names starting with BOKUN_.
export function GET() {
  const a = process.env.BOKUN_ACCESS_KEY || "";
  const s = process.env.BOKUN_SECRET_KEY || "";
  const bokunVarNames = Object.keys(process.env).filter((k) => k.startsWith("BOKUN")).sort();
  // Value-free: does THIS running deploy see other known vars? If it sees LINE/AUTH
  // but not BOKUN, the Bokun vars were saved but never deployed (same env). If it
  // sees none of them, the running deploy is a different service/environment.
  const seen = (k: string) => !!process.env[k];
  return NextResponse.json({
    enabled: !!(a && s),
    accessKey: { present: !!a, length: a.length },
    secretKey: { present: !!s, length: s.length },
    bokunVarNamesSeen: bokunVarNames,
    runningDeploySees: {
      DATABASE_URL: seen("DATABASE_URL"), AUTH_SECRET: seen("AUTH_SECRET"),
      LINE_CHANNEL_SECRET: seen("LINE_CHANNEL_SECRET"), VAPID_PRIVATE_KEY: seen("VAPID_PRIVATE_KEY"),
      ADMIN_EMAIL: seen("ADMIN_EMAIL"), BOKUN_WEBHOOK_TOKEN: seen("BOKUN_WEBHOOK_TOKEN"),
    },
    envVarCount: Object.keys(process.env).length,
  });
}
