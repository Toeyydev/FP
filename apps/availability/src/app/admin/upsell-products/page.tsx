import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAccountant, isAdmin } from "@/lib/roles";
import { upsellEnabled } from "@/lib/upsell/flags";
import { UpsellProductList } from "@/components/UpsellProducts";

// Settings › Upsell products. ADMIN edits, ACCOUNTANT reads; absent while UPSELL_ENABLED is
// off. The checks here are a courtesy — every API this page calls checks again, against the
// database (lib/upsell/settings-access).
export const dynamic = "force-dynamic";

export default async function UpsellProductsPage() {
  if (!upsellEnabled()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/start");
  const r = session.user.role as string | undefined;
  if (!isAdmin(r) && !isAccountant(r)) redirect("/");
  return <UpsellProductList />;
}
