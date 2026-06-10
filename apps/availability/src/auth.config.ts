import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";

const ACCESS_TTL_SEC = 8 * 60 * 60; // keep in sync with lib/sessionTokens (edge can't import it — pulls prisma)
const REFRESH_COOKIE = "folkpath_rt";

// Edge-safe base config (NO database / Node-only imports here). Used by the
// middleware. Providers that touch the DB are added in auth.ts.
export const authConfig = {
  // Use the browser's Host header (guide.folkpaths.com) for redirects/cookies,
  // not the Railway upstream hostname baked into AUTH_URL.
  trustHost: true,
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
        p.startsWith("/api/session") || p.startsWith("/api/password") || p.startsWith("/api/version") ||
        p === "/api/line/webhook" || p === "/api/offers/sweep" || p === "/api/bokun/webhook" || p === "/api/push/health" || p === "/api/email/health" || p === "/api/bokun/health" || p === "/api/google/health" ||
        p.startsWith("/api/passkey");
      if (isPublic) return true;
      if (auth?.user) return true;

      // Build redirects from the REAL public host (the browser's Host header), so
      // the user is never bounced onto the Railway upstream hostname / AUTH_URL —
      // they stay on whatever domain they're using (e.g. guide.folkpaths.com).
      const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host;
      const proto = request.headers.get("x-forwarded-proto") || (request.nextUrl.protocol.replace(":", "")) || "https";
      const base = `${proto}://${host}`;

      // No valid access session, but a "remember me" refresh token is present:
      // bounce through the refresh route to silently re-mint the access session.
      // Pass the real host (Node routes only see Railway's internal host) so the
      // re-minted Secure cookie + redirect stay on this domain (no redirect loop).
      if (request.cookies.get(REFRESH_COOKIE)) {
        return NextResponse.redirect(new URL(`/api/session/refresh?next=${encodeURIComponent(p)}&h=${encodeURIComponent(host)}`, base));
      }
      // Otherwise send them to sign in — on the same domain.
      return NextResponse.redirect(new URL(`/start?callbackUrl=${encodeURIComponent(p)}`, base));
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
