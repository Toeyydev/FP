import { describe, it, expect } from "vitest";
import {
  reconcile,
  normalizePortalStatus,
  normalizeChannelStatus,
  type PortalBookingState,
  type ChannelBookingState,
} from "./reconcile";

const portal = (over: Partial<PortalBookingState> = {}): PortalBookingState => ({
  bookingId: "b1",
  externalId: "BK-1",
  ref: "GYG-1",
  status: "Active",
  pax: 2,
  ...over,
});

describe("normalizePortalStatus", () => {
  it("treats CANCELLED and IGNORED as Cancelled, everything else Active", () => {
    expect(normalizePortalStatus("CANCELLED")).toBe("Cancelled");
    expect(normalizePortalStatus("ignored")).toBe("Cancelled");
    for (const s of ["PENDING", "OFFERED", "ASSIGNED"]) expect(normalizePortalStatus(s)).toBe("Active");
  });
});

describe("normalizeChannelStatus", () => {
  it("maps cancelled-like statuses to Cancelled, confirmed to Active", () => {
    for (const s of ["CANCELLED", "declined", "EXPIRED", "Rejected"]) expect(normalizeChannelStatus(s)).toBe("Cancelled");
    for (const s of ["CONFIRMED", "confirmed", "ACCEPTED"]) expect(normalizeChannelStatus(s)).toBe("Active");
  });
});

describe("reconcile", () => {
  it("agrees → OK (no drift)", () => {
    const r = reconcile(portal(), { found: true, status: "Active", pax: 2 });
    expect(r.kind).toBe("OK");
    expect(r.drift).toBe(false);
  });

  it("portal cancelled but channel still active → STATUS_MISMATCH (cancel on GYG)", () => {
    const r = reconcile(portal({ status: "Cancelled" }), { found: true, status: "Active", pax: 2 });
    expect(r.kind).toBe("STATUS_MISMATCH");
    expect(r.action).toMatch(/cancel it on GYG/i);
    expect(r.drift).toBe(true);
  });

  it("channel cancelled but portal still active → STATUS_MISMATCH (update portal)", () => {
    const r = reconcile(portal({ status: "Active" }), { found: true, status: "Cancelled", pax: 2 });
    expect(r.kind).toBe("STATUS_MISMATCH");
    expect(r.action).toMatch(/update the portal/i);
  });

  it("both active but pax differ → PAX_MISMATCH", () => {
    const r = reconcile(portal({ pax: 4 }), { found: true, status: "Active", pax: 2 });
    expect(r.kind).toBe("PAX_MISMATCH");
    expect(r.action).toContain("portal 4");
    expect(r.action).toContain("GetYourGuide 2");
  });

  it("pax differ but both cancelled → OK (pax irrelevant once cancelled)", () => {
    const r = reconcile(portal({ status: "Cancelled", pax: 4 }), { found: true, status: "Cancelled", pax: 2 });
    expect(r.kind).toBe("OK");
  });

  it("portal active but channel has no record → MISSING_ON_CHANNEL", () => {
    const r = reconcile(portal({ status: "Active" }), { found: false });
    expect(r.kind).toBe("MISSING_ON_CHANNEL");
    expect(r.drift).toBe(true);
  });

  it("portal cancelled and channel has no record → OK (nothing to do)", () => {
    const r = reconcile(portal({ status: "Cancelled" }), { found: false });
    expect(r.kind).toBe("OK");
    expect(r.drift).toBe(false);
  });
});
