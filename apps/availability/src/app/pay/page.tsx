import { auth } from "@/auth";
import Pay from "@/components/Pay";
import MyPay from "@/components/MyPay";

// Guide: a simple view of their own pay (daily / monthly + the bank slip to check).
// Operator/admin: the payment-approvals pipeline.
export default async function PayPage() {
  const session = await auth();
  const isOperator = session?.user?.role === "OPERATOR" || session?.user?.role === "ADMIN";
  return isOperator ? <Pay isOperator /> : <MyPay />;
}
