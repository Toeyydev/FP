import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";

const ACCESS_TTL_SEC = 8 * 60 * 60; // keep in sync with lib/sessionTokens (edge can't import it — pulls prisma)
const REFRESH_COOKIE = "folkpath_rt";

// Edge-safe base config (NO database / Node-only imports here). Used by the
// middleware. Providers that touch the DB are added in auth.ts.
export const authConfig = {
  session: { strategy: "jwt", maxAge: ACCESS_TTL_SEC },
  jwt: { maxAge: ACCESS_TTL_SEC },
  pages: { signIn: "/start" },
  providers: [],
  callbacks: {
    // Gate every route except the pre-login entry, sign-in, and provisioning flows.
    authorized({ auth, request }) {
      const p = request.nextUrl.pathname;
      const isPublic =
        p === "/start" || p.startsWith("/signin") || p.startsWith("/claim") || p.startsWith("/request") ||
        p.startsWith("/forgot") || p.startsWith("/reset") ||
        p.startsWith("/api/auth") || p.startsWith("/api/claim") || p.startsWith("/api/request") ||
        p.startsWith("/api/session") || p.startsWith("/api/password");
      if (isPublic) return true;
      if (auth?.user) return true;
      // No valid access session, but a "remember me" refresh token is present:
      // bounce through the refresh route to silently re-mint the access session.
      if (request.cookies.get(REFRESH_COOKIE)) {
        const url = request.nextUrl.clone();
        url.pathname = "/api/session/refresh";
        url.search = `?next=${encodeURIComponent(p)}`;
        return NextResponse.redirect(url);
      }
      return false;
    },
    jwt({ token, user }) {
      if (user) {
        const u = user as { role?: string; guideId?: string | null; name?: string | null };
        (token as Record<string, unknown>).role = u.role;
        (token as Record<string, unknown>).guideId = u.guideId ?? null;
        (token as Record<string, unknown>).displayName = u.name ?? null;
      }
      return token;
    },
    session({ session, token }) {
      const t = token as Record<string, unknown>;
      const su = session.user as unknown as Record<string, unknown>;
      su.id = token.sub;
      su.role = t.role;
      su.guideId = t.guideId;
      su.displayName = t.displayName;
      return session;
    },
  },
} satisfies NextAuthConfig;
