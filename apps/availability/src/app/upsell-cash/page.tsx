import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isAdmin } from "@/lib/roles";
import { upsellEnabled } from "@/lib/upsell/flags";
import UpsellCash from "@/components/UpsellCash";

// Finance › Extras cash (Tour Upsell PR4): the guides' hand-ins, sale reversals and the receiving
// account. Finance reads; an Admin decides (the server re-checks every write). Off with the switch.
export default async function UpsellCashPage() {
  if (!upsellEnabled()) redirect("/");
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <UpsellCash isAdmin={isAdmin(session?.user?.role)} />;
}
