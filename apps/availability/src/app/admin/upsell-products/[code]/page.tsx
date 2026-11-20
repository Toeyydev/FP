import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAccountant, isOps } from "@/lib/roles";
import { upsellEnabled } from "@/lib/upsell/flags";
import { UpsellProductEdit } from "@/components/UpsellProducts";

// One upsell product's settings. ADMIN edits, OPERATOR and ACCOUNTANT read; absent while UPSELL_ENABLED
// is off. The API checks the role again on every request.
export const dynamic = "force-dynamic";

export default async function UpsellProductPage({ params }: { params: Promise<{ code: string }> }) {
  if (!upsellEnabled()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/start");
  const r = session.user.role as string | undefined;
  if (!isOps(r) && !isAccountant(r)) redirect("/");
  const { code } = await params;
  return <UpsellProductEdit code={decodeURIComponent(code)} />;
}
