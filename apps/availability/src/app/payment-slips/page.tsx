import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isOps } from "@/lib/roles";
import PaymentSlips from "@/components/PaymentSlips";

// Operator payment-slip review — finance roles only. Shows each parsed bank payment
// with the Transaction ID and the Folkpaths reference as separate fields, and a
// needs-review queue. Operators/admin can confirm or dismiss; the Accountant role
// is read-only (canEdit=false) and may not move money.
export default async function PaymentSlipsPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <PaymentSlips canEdit={isOps(session!.user!.role)} />;
}
