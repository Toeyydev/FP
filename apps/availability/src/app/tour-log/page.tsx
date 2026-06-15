import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance, isOps } from "@/lib/roles";
import TourLog from "@/components/TourLog";

// Operator tour log — finance roles may VIEW; only operators rate / remove entries.
export default async function TourLogPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <TourLog canEdit={isOps(session!.user!.role)} />;
}
