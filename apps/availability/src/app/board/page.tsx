import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAccountant } from "@/lib/roles";
import AppClient from "@/components/AppClient";

// The availability / dispatch board. This is now the same view served at "/"
// (home) for operators; kept as a stable /board alias for existing links.
export default async function BoardPage() {
  const session = await auth();
  if (!session?.user) redirect("/start");
  if (isAccountant(session.user.role)) redirect("/payments");

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
