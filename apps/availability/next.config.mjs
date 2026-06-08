/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A unique id per build, baked into BOTH the client and (via inlining) the
  // /api/version response, so they always match for a given deploy and differ
  // across deploys — that's what makes the auto-refresh work without looping.
  // Falls back to a build timestamp if Railway's commit SHA isn't set at build.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.RAILWAY_GIT_COMMIT_SHA || `t${Date.now()}`,
  },
  // Security headers applied to every response. This is the "safe" set that
  // cannot break script/style loading. A full Content-Security-Policy with
  // script-src/style-src needs testing against the PWA first — see
  // SECURITY-PUNCHLIST.md.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
