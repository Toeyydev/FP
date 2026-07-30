import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAccountant } from "@/lib/roles";
import AppClient from "@/components/AppClient";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  if (isAccountant(session.user.role)) redirect("/payments");

  // Home for everyone: operators/admins get the Board (their control surface),
  // guides get their own view. Accountants were redirected above.
  const r = session.user.role;
  const role = r === "OPERATOR" || r === "ADMIN" ? "operator" : "guide";
  return (
    <AppClient
      role={role}
      isAdmin={r === "ADMIN"}
      guideId={session.user.guideId ?? null}
      displayName={session.user.displayName ?? session.user.name ?? ""}
    />
  );
}
