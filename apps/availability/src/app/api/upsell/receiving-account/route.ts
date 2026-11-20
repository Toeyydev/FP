import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { setReceivingAccount } from "@/lib/upsell/settlement";
import { resolveBankAccount } from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

// GET — the receiving account for Extras cash (null = not set yet) and its earlier versions.
export async function GET() {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  const all = await prisma.upsellReceivingAccount.findMany({ orderBy: { version: "desc" } });
  const view = (x: (typeof all)[number]) => ({ id: x.id, version: x.version, label: x.label, display: x.accountDisplay, peakPaymentMethodName: x.peakPaymentMethodName, confirmedAt: x.confirmedAt, retiredAt: x.retiredAt });
  return NextResponse.json({ current: all.find((x) => !x.retiredAt) ? view(all.find((x) => !x.retiredAt)!) : null, versions: all.map(view) });
}

// POST { peakPaymentMethodId, label, confirmSuitable } — ADMIN: a new version, resolved against
// PEAK itself (never from the browser); fails closed when PEAK cannot say.
export async function POST(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const r = await setReceivingAccount(prisma, { userId: a.userId }, { peakPaymentMethodId: String(b?.peakPaymentMethodId ?? ""), label: String(b?.label ?? ""), confirmSuitable: b?.confirmSuitable === true }, async (id) => {
      const m = await resolveBankAccount(id);
      if (!m.ok) return null;
      const digits = m.key.replace(/\D+/g, "");
      return { id, name: m.name, bankAccountKey: m.key, accountDisplay: digits ? `···${digits.slice(-4)}` : m.name ?? id };
    });
    return { ok: true, version: r.version, display: r.accountDisplay };
  });
}
