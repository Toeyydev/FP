import { redirect } from "next/navigation";
import { auth } from "@/auth";
import MyPay from "@/components/MyPay";

// Guide: a simple view of their own pay (daily / monthly + the bank slip to check).
// Operator/admin: the separate "Approvals" step was removed — Payments is now the
// single pay screen (it shows every owed tour and is where the e-slip is uploaded),
// so operators are sent straight there.
export default async function PayPage() {
  const session = await auth();
  const isOperator = session?.user?.role === "OPERATOR" || session?.user?.role === "ADMIN";
  if (isOperator) redirect("/payments");
  return <MyPay />;
}
