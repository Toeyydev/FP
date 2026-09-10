import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { authConfig } from "./auth.config";

// The edge gate, with no session at all.
const gate = async (path: string) =>
  authConfig.callbacks.authorized({ auth: null, request: new NextRequest(`https://ops.folkpaths.com${path}`) } as never);

describe("authorized — FolkOPS Mobile routes", () => {
  it("lets /api/mobile/* through to the bearer check each route does itself", async () => {
    for (const p of ["/api/mobile/auth/login", "/api/mobile/auth/refresh", "/api/mobile/schedule", "/api/mobile/tour-details"]) {
      expect(await gate(p), p).toBe(true);
    }
  });

  it("still sends a cookie-less request for the web routes to sign in", async () => {
    for (const p of ["/api/schedule", "/api/tour-details", "/api/mobile", "/api/mobilex/schedule"]) {
      const res = await gate(p);
      expect(res, p).toBeInstanceOf(Response);
      expect((res as Response).headers.get("location"), p).toContain("/start?callbackUrl=");
    }
  });
});
