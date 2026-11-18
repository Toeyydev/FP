import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAccountant, isAdmin } from "@/lib/roles";
import { upsellEnabled } from "@/lib/upsell/flags";
import { UpsellProductEdit } from "@/components/UpsellProducts";

// One upsell product's settings. ADMIN edits, ACCOUNTANT reads; absent while UPSELL_ENABLED
// is off. The API checks the role again on every request.
export const dynamic = "force-dynamic";

export default async function UpsellProductPage({ params }: { params: Promise<{ code: string }> }) {
  if (!upsellEnabled()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/start");
  const r = session.user.role as string | undefined;
  if (!isAdmin(r) && !isAccountant(r)) redirect("/");
  const { code } = await params;
  return <UpsellProductEdit code={decodeURIComponent(code)} />;
}
