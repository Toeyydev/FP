import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import ExpenseReview from "@/components/ExpenseReview";

// The operator's queue of guide expense reports awaiting cross-check. Finance roles
// view it; acting on a row happens on the job sheet, which enforces its own rules.
export default async function ExpenseReviewPage() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) redirect("/");
  return <ExpenseReview />;
}
