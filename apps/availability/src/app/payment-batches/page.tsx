import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isOps } from "@/lib/roles";
import PaymentBatches from "@/components/PaymentBatches";

// Operator payment batches — finance roles only. Operators/admin can create batches,
// change status and delete; the Accountant role is read-only (and, per the current
// middleware, is confined to /payments — batches become visible to them once that
// allowlist is widened, which is an auth change left for an explicit decision).
export default async function PaymentBatchesPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <PaymentBatches canEdit={isOps(session!.user!.role)} />;
}
