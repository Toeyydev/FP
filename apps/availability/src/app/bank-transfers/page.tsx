import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isAdmin } from "@/lib/roles";
import BankTransfers from "@/components/BankTransfers";

// Payments › Bank transfers — the bank-transaction registry (PR4-0b). Finance reads; an Admin
// corrects (the server re-checks the role on every write).
export default async function BankTransfersPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <BankTransfers isAdmin={isAdmin(session?.user?.role)} />;
}
