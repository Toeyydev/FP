import type { Metadata } from "next";
import GuestWalkInStatus from "@/components/GuestWalkInStatus";

// PUBLIC: the guest's own registration; its token is in the URL fragment (never sent as a URL).
export const metadata: Metadata = { title: "Folkpaths · registration", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function Page() {
  return <GuestWalkInStatus />;
}
