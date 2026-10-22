import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import JobSheetsPdf from "@/components/JobSheetsPdf";

// ADMIN only. The redirect is a courtesy; the endpoint checks the role again.
export const dynamic = "force-dynamic";

export default async function JobSheetsPdfPage() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  if (!isAdmin(session.user.role)) redirect("/");
  return <JobSheetsPdf />;
}
