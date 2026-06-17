import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { peakConfigured, peakEnabled, peakBaseUrl, clientToken } from "@/lib/peak-api";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
export const dynamic = "force-dynamic";

// GET — operator/admin only. Verify the PEAK connection: are the env creds present,
// and can we fetch a client token from PEAK right now? Surfaces PEAK's own
// resCode/resDesc so we can tune signing on first contact. Never leaks the creds.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!peakConfigured) return NextResponse.json({ configured: false, hint: "Set PEAK_CONNECT_ID and PEAK_CONNECT_KEY (and PEAK_USER_TOKEN) in Railway." });
  const t = await clientToken(true);
  return NextResponse.json({
    configured: true,
    baseUrl: peakBaseUrl,
    userTokenSet: peakEnabled,
    connected: t.ok,
    peakCode: t.code ?? null,
    detail: t.desc ?? null,
  });
}
