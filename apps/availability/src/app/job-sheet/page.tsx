import { Suspense } from "react";
import JobSheetEditor from "@/components/JobSheetEditor";

// Operator-only job-sheet editor. Access enforced by the /api/jobsheet endpoints.
export default function JobSheetPage() {
  return (
    <Suspense fallback={<div className="wrap"><section className="panel"><div className="op-empty">…</div></section></div>}>
      <JobSheetEditor />
    </Suspense>
  );
}
