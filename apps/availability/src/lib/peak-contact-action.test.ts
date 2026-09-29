import { describe, it, expect } from "vitest";
import { contactSaveDecision, contactSaveHint, contactBoxOpen } from "./peak-contact-action";

describe("contactSaveDecision", () => {
  it("refuses to save nothing — the bug that logged 17 phantom clears", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(contactSaveDecision(v, null)).toEqual({ action: "blocked", reason: "empty" });
    }
  });

  it("still refuses a blank save when a mapping EXISTS — this is the data loss", () => {
    expect(contactSaveDecision("", "CT-900")).toEqual({ action: "blocked", reason: "empty" });
    expect(contactSaveDecision("  ", "CT-900")).toEqual({ action: "blocked", reason: "empty" });
  });

  it("saves a first mapping", () => {
    expect(contactSaveDecision("CT-123", null)).toEqual({ action: "save", contactId: "CT-123" });
  });

  it("saves a change to a different contact", () => {
    expect(contactSaveDecision("CT-456", "CT-123")).toEqual({ action: "save", contactId: "CT-456" });
  });

  it("does not rewrite the contact already stored", () => {
    expect(contactSaveDecision("CT-123", "CT-123")).toEqual({ action: "blocked", reason: "unchanged" });
    expect(contactSaveDecision(" CT-123 ", "CT-123")).toEqual({ action: "blocked", reason: "unchanged" });
  });

  it("trims the id it hands on, so a padded paste maps to the real contact", () => {
    expect(contactSaveDecision("  CT-77  ", null)).toEqual({ action: "save", contactId: "CT-77" });
  });

  it("explains a blocked press without calling it an error, and says nothing when savable", () => {
    expect(contactSaveHint(contactSaveDecision("", null))).toMatch(/Pick the guide/);
    expect(contactSaveHint(contactSaveDecision("CT-1", "CT-1"))).toMatch(/already mapped/);
    expect(contactSaveHint(contactSaveDecision("CT-1", null))).toBeUndefined();
  });
});

describe("contactBoxOpen", () => {
  it("is open for an unmapped guide even before the operator touches it", () => {
    // The regression: this is the state of every guide in production, and the
    // fetch used to skip it, so the list never arrived.
    expect(contactBoxOpen(null, false)).toBe(true);
  });

  it("is closed for a mapped guide until they open it", () => {
    expect(contactBoxOpen(null, true)).toBe(false);
  });

  it("is open once the operator opens it, mapped or not", () => {
    expect(contactBoxOpen("", true)).toBe(true);
    expect(contactBoxOpen("CT-1", true)).toBe(true);
    expect(contactBoxOpen("", false)).toBe(true);
  });
});
