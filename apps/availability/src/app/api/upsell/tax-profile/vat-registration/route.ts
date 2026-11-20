import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { setVatRegistration } from "@/lib/upsell/tax-profile";

export const dynamic = "force-dynamic";

// POST { code, vatRegistration: NOT_REGISTERED | REGISTERED, source } — ADMIN: whether the company is
// VAT-registered, with where the answer came from. Audited; the profile stays DRAFT.
export async function POST(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const t = await setVatRegistration(prisma, { userId: a.userId }, { code: String(b?.code ?? ""), vatRegistration: String(b?.vatRegistration ?? "") as "NOT_REGISTERED", source: String(b?.source ?? "") });
    return { ok: true, code: t.code, vatRegistration: t.vatRegistration, status: t.status };
  });
}
