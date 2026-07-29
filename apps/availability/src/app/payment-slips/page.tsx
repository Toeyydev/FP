import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import PaymentSlips from "@/components/PaymentSlips";

// Operator payment-slip review — finance roles only. Shows each parsed bank payment
// with the Transaction ID and the Folkpaths reference as separate fields, and a
// needs-review queue for the ones the matcher couldn't clear automatically.
export default async function PaymentSlipsPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <PaymentSlips />;
}
