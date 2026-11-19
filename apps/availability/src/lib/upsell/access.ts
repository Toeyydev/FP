import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { upsellRouteExtensionEnabled } from "./flags";

// Who may sell an upsell on a job (PR3: the Route Extension), checked on every request.
//
//  • While UPSELL_ENABLED or UPSELL_ROUTE_EXTENSION_ENABLED is off, selling does not exist:
//    404 for everyone, and the guide's job sheet shows no Extras block.
//  • Only a GUIDE sells, and only on their own job (lib/upsell/sales checks the job). Operators,
//    admins and accountants cannot record a guest's cash for a guide.
//
// As in settings-access: the session's role and guide code must match the database now, and
// the account must still be active.

export type SaleAccess =
  | { ok: true; userId: string; guideId: string }
  | { ok: false; status: 401 | 403 | 404 };

export async function upsellSaleAccess(): Promise<SaleAccess> {
  if (!upsellRouteExtensionEnabled()) return { ok: false, status: 404 };
  const session = await auth();
  const id = session?.user?.id ?? null;
  if (!id) return { ok: false, status: 401 };
  const claimedRole = session?.user?.role as string | undefined;
  const claimedGuide = (session?.user as { guideId?: string | null } | undefined)?.guideId ?? null;
  if (claimedRole !== "GUIDE" || !claimedGuide) return { ok: false, status: 403 };
  const me = await prisma.user.findUnique({ where: { id }, select: { role: true, state: true, guideId: true } });
  if (!me || me.role !== "GUIDE" || me.state !== "ACTIVE" || me.guideId !== claimedGuide) return { ok: false, status: 403 };
  return { ok: true, userId: id, guideId: claimedGuide };
}
