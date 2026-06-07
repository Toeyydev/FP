import { redirect } from "next/navigation";
import { auth } from "@/auth";
import ProductMapping from "@/components/ProductMapping";

// Operator: map channel products (Bokun/GetYourGuide) → Folkpaths tours so
// bookings auto-land on a tour and combine into one job.
export default async function ProductMapPage() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  const r = session.user.role;
  if (r !== "OPERATOR" && r !== "ADMIN") redirect("/");
  return <ProductMapping />;
}
