import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AdminConsole from "@/components/AdminConsole";

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  const r = session.user.role;
  if (r !== "OPERATOR" && r !== "ADMIN") redirect("/");
  return <AdminConsole />;
}
