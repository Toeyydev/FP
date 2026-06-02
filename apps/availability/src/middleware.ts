import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Edge middleware: uses only the DB-free base config. The `authorized` callback
// redirects unauthenticated requests to /signin.
export default NextAuth(authConfig).auth;

export const config = {
  // Exclude auth API, Next internals, and static/PWA files (manifest, service
  // worker, icons) — otherwise unauthenticated requests for them get redirected
  // to /start and the app isn't installable.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.png$).*)"],
};
