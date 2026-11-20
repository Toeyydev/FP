import type { Metadata } from "next";
import GuestWalkIn from "@/components/GuestWalkIn";

// PUBLIC: the page a guest's phone opens from the guide's QR (lib/upsell/walk-in-qr). The page
// itself holds nothing; its data comes from /api/public/walk-in/<token>, 404 while the switch is off.
export const metadata: Metadata = { title: "Folkpaths · walk-in", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <GuestWalkIn token={(await params).token} />;
}
