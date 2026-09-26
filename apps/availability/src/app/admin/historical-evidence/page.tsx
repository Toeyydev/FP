import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import HistoricalEvidenceQueue from "@/components/HistoricalEvidenceQueue";

// ADMIN only — not `/admin`, which an operator may also open.
//
// The redirect is a courtesy, not the control. Every endpoint this page calls checks the
// role again on the server, against the database, because a page that hides a button
// still serves the data behind it to anyone who asks for it directly.

export const dynamic = "force-dynamic";

export default async function HistoricalEvidencePage() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  if (!isAdmin(session.user.role)) redirect("/");
  return <HistoricalEvidenceQueue />;
}
