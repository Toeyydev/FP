import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/api/admin/historical-evidence/access";
import SlipCorrection from "@/components/SlipCorrection";

// ADMIN only, checked in the session AND the database before anything renders. The redirect
// is a courtesy; the API behind every button checks both again on each request.

export const dynamic = "force-dynamic";

export default async function SlipCorrectionPage() {
  const who = await requireAdmin();
  if (!who.ok) redirect(who.status === 401 ? "/start" : "/");
  return <Suspense fallback={<div className="wrap"><section className="card" style={{ padding: 16 }}>กำลังโหลด…</section></div>}><SlipCorrection /></Suspense>;
}
