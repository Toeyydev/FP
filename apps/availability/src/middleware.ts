import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Edge middleware: uses only the DB-free base config. The `authorized` callback
// redirects unauthenticated requests to /signin.
export default NextAuth(authConfig).auth;

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
