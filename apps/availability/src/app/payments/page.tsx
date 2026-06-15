import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isOps } from "@/lib/roles";
import Payments from "@/components/Payments";

// Operator payroll — finance roles only. Operators/admin can edit (mark paid,
// e-slip, delete); the Accountant role is read-only and may only record PEAK refs.
export default async function PaymentsPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <Payments canEdit={isOps(session!.user!.role)} />;
}
