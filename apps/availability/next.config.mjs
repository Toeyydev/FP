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
};

export default nextConfig;
