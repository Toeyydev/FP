import { vi, describe, it, expect } from "vitest";

// The month e-slip endpoint is retired by Payments v2: one slip never pays a whole month,
// and payment evidence is never unlinked. All data is invented — this repo is public.
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "op_1", role: "OPERATOR" } })) }));

import { NextRequest } from "next/server";
import { POST, DELETE } from "./route";

const req = (method: string) => new NextRequest("https://ops.folkpaths.com/api/payments/eslip", { method, ...(method === "DELETE" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ period: "2099-04", guideId: "G-TEST" }) } : {}) });

describe("POST /api/payments/eslip — retired", () => {
  it("refuses to pay a month from one slip and points at Record payment", async () => {
    const res = await POST(req("POST"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("use-record-payment");
    expect(body.detail).toContain("Record payment");
  });
});

describe("DELETE /api/payments/eslip — retired", () => {
  it("refuses to unlink a slip: evidence stays with its payment", async () => {
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("evidence-is-kept");
  });
});
