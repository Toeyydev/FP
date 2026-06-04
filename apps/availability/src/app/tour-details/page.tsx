import { Suspense } from "react";
import TourDetails from "@/components/TourDetails";

// Tour details for an assigned job (guide sees own; operator can pass guideId).
export default function TourDetailsPage() {
  return (
    <Suspense fallback={<div className="wrap"><section className="panel"><div className="op-empty">…</div></section></div>}>
      <TourDetails />
    </Suspense>
  );
}
