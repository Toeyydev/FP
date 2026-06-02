/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bake the deployed commit into the client so it can detect when a newer
  // version has shipped and auto-refresh. Railway provides the SHA at build time.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.RAILWAY_GIT_COMMIT_SHA || "dev",
  },
};

export default nextConfig;
