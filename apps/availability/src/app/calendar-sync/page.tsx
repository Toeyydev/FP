import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import CalendarSync from "@/components/CalendarSync";

// Operators and admins only. The redirect is a courtesy; the API checks the role again.
export const dynamic = "force-dynamic";

export default async function CalendarSyncPage() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  if (!isOps(session.user.role)) redirect("/");
  return <CalendarSync />;
}
