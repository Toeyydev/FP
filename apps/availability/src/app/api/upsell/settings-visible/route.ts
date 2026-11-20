import { NextResponse } from "next/server";
import { upsellSettingsAccess } from "@/lib/upsell/settings-access";

export const dynamic = "force-dynamic";

// GET — whether this person's menu shows Settings › Upsell products. Always 200 with a
// boolean, so the menu never has to tell "hidden" from "failed".
export async function GET() {
  const a = await upsellSettingsAccess().catch(() => null);
  return NextResponse.json({ visible: !!a?.ok });
}
