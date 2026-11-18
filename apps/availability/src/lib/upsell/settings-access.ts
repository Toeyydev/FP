import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { upsellEnabled } from "./flags";

// Who may open Settings › Upsell products, checked on every request.
//
//  • While UPSELL_ENABLED is off the whole thing does not exist: 404 for everyone, the
//    menu item hidden. (Owner: every switch stays off until they turn it on.)
//  • ADMIN edits. ACCOUNTANT reads — prices, costs and accounting categories, no buttons.
//    OPERATOR and GUIDE get 403.
//
// The session says what role someone had when they signed in; the database says what role
// they have now. Both must agree, and the account must still be active.

export type SettingsAccess =
  | { ok: true; userId: string; role: "ADMIN" | "ACCOUNTANT"; canEdit: boolean }
  | { ok: false; status: 401 | 403 | 404 };

export async function upsellSettingsAccess(): Promise<SettingsAccess> {
  if (!upsellEnabled()) return { ok: false, status: 404 };
  const session = await auth();
  const id = session?.user?.id ?? null;
  if (!id) return { ok: false, status: 401 };
  const claimed = session?.user?.role as string | undefined;
  if (claimed !== "ADMIN" && claimed !== "ACCOUNTANT") return { ok: false, status: 403 };
  const me = await prisma.user.findUnique({ where: { id }, select: { role: true, state: true } });
  if (!me || me.role !== claimed || me.state !== "ACTIVE") return { ok: false, status: 403 };
  return { ok: true, userId: id, role: claimed, canEdit: claimed === "ADMIN" };
}
