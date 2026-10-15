import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import JobProcessBoard from "@/components/JobProcessBoard";

// Job process — every job on the TO-BE path, with the stage it has reached and who it is
// waiting for. Read-only; the finance roles may view it.
export default async function ProcessPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <JobProcessBoard />;
}
