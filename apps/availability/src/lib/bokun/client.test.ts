import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { bokunDate, bokunSignature, channelPax } from "./client";

describe("bokunDate", () => {
  it("formats UTC as yyyy-MM-dd HH:mm:ss", () => {
    expect(bokunDate(new Date("2026-07-21T10:09:05.123Z"))).toBe("2026-07-21 10:09:05");
  });
});

describe("bokunSignature", () => {
  const base = { date: "2026-07-21 10:09:05", accessKey: "AK", secretKey: "SECRET", method: "GET", path: "/booking.json/123" };

  it("is base64 HMAC-SHA1 over date + accessKey + METHOD + path", () => {
    // Independent reference computation of the documented message layout.
    const expected = createHmac("sha1", base.secretKey)
      .update(base.date + base.accessKey + "GET" + base.path, "utf8")
      .digest("base64");
    expect(bokunSignature(base)).toBe(expected);
  });

  it("uppercases the method", () => {
    expect(bokunSignature({ ...base, method: "get" })).toBe(bokunSignature({ ...base, method: "GET" }));
  });

  it("is deterministic and changes when any input changes", () => {
    const sig = bokunSignature(base);
    expect(bokunSignature(base)).toBe(sig);
    expect(bokunSignature({ ...base, path: "/booking.json/124" })).not.toBe(sig);
    expect(bokunSignature({ ...base, accessKey: "AK2" })).not.toBe(sig);
    expect(bokunSignature({ ...base, secretKey: "SECRET2" })).not.toBe(sig);
    expect(bokunSignature({ ...base, date: "2026-07-21 10:09:06" })).not.toBe(sig);
  });
});

describe("channelPax", () => {
  it("prefers totalParticipants when present", () => {
    expect(channelPax({ totalParticipants: 4 })).toBe(4);
  });

  it("falls back to summing price-category quantities across product bookings", () => {
    const json = {
      productBookings: [
        { priceCategoryBookings: [{ quantity: 2 }, { quantity: 1 }] },
        { priceCategoryBookings: [{ quantity: 3 }] },
      ],
    };
    expect(channelPax(json)).toBe(6);
  });

  it("returns 0 when nothing is parseable", () => {
    expect(channelPax({})).toBe(0);
  });
});
