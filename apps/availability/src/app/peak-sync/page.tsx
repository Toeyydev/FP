import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isOps } from "@/lib/roles";
import PeakSync from "@/components/PeakSync";

// PEAK accounting monitor — finance roles view; the connection test is ops-only
// (the /api/peak/test endpoint enforces that server-side as well).
export default async function PeakSyncPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <PeakSync canEdit={isOps(session!.user!.role)} />;
}
