import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isOps } from "@/lib/roles";
import Reviews from "@/components/Reviews";

// Review incentives — finance roles only. Operators/admin can create/match/pay;
// the Accountant role is read-only.
export default async function ReviewsPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <Reviews canEdit={isOps(session!.user!.role)} />;
}
