import { auth } from "@/auth";
import Pay from "@/components/Pay";

// Guide: their pay pipeline (Pending/Approved/Paid). Operator: approvals.
export default async function PayPage() {
  const session = await auth();
  const isOperator = session?.user?.role === "OPERATOR" || session?.user?.role === "ADMIN";
  return <Pay isOperator={isOperator} />;
}
