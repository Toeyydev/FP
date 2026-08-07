import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAccountant } from "@/lib/roles";
import AppClient from "@/components/AppClient";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  if (isAccountant(session.user.role)) redirect("/payments");
  // Operators/admins land on the Board (their home); the Dashboard was removed.
  if (session.user.role === "OPERATOR" || session.user.role === "ADMIN") redirect("/board");

  // Only guides reach here — operators/admins/accountants were redirected above.
  return (
    <AppClient
      role="guide"
      isAdmin={false}
      guideId={session.user.guideId ?? null}
      displayName={session.user.displayName ?? session.user.name ?? ""}
    />
  );
}
