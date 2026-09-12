import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { authConfig } from "./auth.config";

// The edge gate, with no session at all.
const gate = async (path: string, init?: { method?: string; refreshCookie?: boolean }) =>
  authConfig.callbacks.authorized({
    auth: null,
    request: new NextRequest(`https://ops.folkpaths.com${path}`, {
      method: init?.method ?? "GET",
      headers: init?.refreshCookie ? { cookie: "folkpath_rt=rt_abc" } : undefined,
    }),
  } as never);

describe("authorized — FolkOPS Mobile routes", () => {
  it("lets /api/mobile/* through to the bearer check each route does itself", async () => {
    for (const p of ["/api/mobile/auth/login", "/api/mobile/auth/refresh", "/api/mobile/schedule", "/api/mobile/tour-details"]) {
      expect(await gate(p), p).toBe(true);
    }
  });
});

// An API request gets a status code, not a login page. fetch() follows redirects by
// default and /start answers 200, so redirecting an expired API call made every one
// of the ~143 client fetches read as a success that never happened.
describe("authorized — an unauthenticated API call is answered, not redirected", () => {
  it("answers 401 JSON for a gated API path", async () => {
    for (const p of ["/api/availability", "/api/schedule", "/api/tour-details", "/api/mobile", "/api/mobilex/schedule"]) {
      const res = (await gate(p)) as Response;
      expect(res, p).toBeInstanceOf(Response);
      expect(res.status, p).toBe(401);
      expect(res.headers.get("location"), p).toBeNull();
      expect(await res.json(), p).toEqual({ error: "unauthorized" });
    }
  });

  it("still sends a cookie-less PAGE request to sign in", async () => {
    for (const p of ["/", "/bookings", "/payments", "/job-sheet"]) {
      const res = (await gate(p)) as Response;
      expect(res.headers.get("location"), p).toContain("/start?callbackUrl=");
    }
  });

  it("keeps the silent re-mint for a GET, which is the only method it can serve", async () => {
    // /api/session/refresh exports GET only, and a 307 preserves the method — so
    // bouncing a PUT there lands on 405 and can never refresh anything.
    const get = (await gate("/api/schedule", { refreshCookie: true })) as Response;
    expect(get.headers.get("location")).toContain("/api/session/refresh?next=");

    const put = (await gate("/api/availability", { method: "PUT", refreshCookie: true })) as Response;
    expect(put.status).toBe(401);
    expect(put.headers.get("location")).toBeNull();
  });

  it("still bounces a page GET with a refresh cookie", async () => {
    const res = (await gate("/bookings", { refreshCookie: true })) as Response;
    expect(res.headers.get("location")).toContain("/api/session/refresh?next=");
  });
});
