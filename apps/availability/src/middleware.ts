import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Edge middleware: uses only the DB-free base config. The `authorized` callback
// redirects unauthenticated requests to /signin.
export default NextAuth(authConfig).auth;

export const config = {
  // Exclude auth API, Next internals, and static/PWA files (manifest, service
  // worker, icons) — otherwise unauthenticated requests for them get redirected
  // to /start and the app isn't installable.
  //
  // `privacy` is public on purpose: Google Play will not accept a privacy policy
  // that sits behind a login, and everything else on this site needs one.
  matcher: ["/((?!api/auth|api/health|privacy|_next/static|_next/image|favicon.ico|manifest.webmanifest|manifest.json|sw.js|service-worker.js|offline.html|.*\\.png$).*)"],
};
