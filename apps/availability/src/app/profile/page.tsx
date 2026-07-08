import { redirect } from "next/navigation";
import { auth } from "@/auth";
import ProfileForm from "@/components/ProfileForm";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ userId?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/start");
  const sp = await searchParams;
  // Only operators/admins may view another user's profile; guides always see their own.
  const isOps = session.user.role === "OPERATOR" || session.user.role === "ADMIN";
  const targetUserId = isOps && sp.userId ? sp.userId : null;
  const isGuideOwn = session.user.role === "GUIDE" && !targetUserId;
  return <ProfileForm targetUserId={targetUserId} isGuideOwn={isGuideOwn} />;
}
