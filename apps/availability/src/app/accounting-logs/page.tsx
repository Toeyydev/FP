import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import AccountingLogs from "@/components/AccountingLogs";

// Finance audit trail — read-only, finance roles (operator/admin/accountant).
export default async function AccountingLogsPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <AccountingLogs />;
}
