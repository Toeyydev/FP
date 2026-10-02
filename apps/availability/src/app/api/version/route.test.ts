import { afterEach, describe, expect, it, vi } from "vitest";

const startSyncLoop = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sync-loop", () => ({ startSyncLoop }));

import { GET } from "./route";

const before = {
  runtime: process.env.RAILWAY_GIT_COMMIT_SHA,
  build: process.env.NEXT_PUBLIC_BUILD_ID,
};

afterEach(() => {
  if (before.runtime === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = before.runtime;
  if (before.build === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID;
  else process.env.NEXT_PUBLIC_BUILD_ID = before.build;
  vi.clearAllMocks();
});

describe("GET /api/version", () => {
  it("prefers the running Railway deployment SHA over a stale inlined build id", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "runtime-new";
    process.env.NEXT_PUBLIC_BUILD_ID = "build-old";
    const res = GET();
    expect(await res.json()).toEqual({ version: "runtime-new" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("falls back to the build id away from Railway", async () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    process.env.NEXT_PUBLIC_BUILD_ID = "local-build";
    expect(await GET().json()).toEqual({ version: "local-build" });
  });

  it("keeps booting the sync loop on every poll", () => {
    GET();
    expect(startSyncLoop).toHaveBeenCalledTimes(1);
  });
});
