import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppClient from "@/components/AppClient";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/start");

  const r = session.user.role;
  const role = r === "OPERATOR" || r === "ADMIN" ? "operator" : "guide";
  const isAdmin = r === "ADMIN";
  return (
    <AppClient
      role={role}
      isAdmin={isAdmin}
      guideId={session.user.guideId ?? null}
      displayName={session.user.displayName ?? session.user.name ?? ""}
    />
  );
}
