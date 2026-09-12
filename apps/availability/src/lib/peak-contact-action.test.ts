import { describe, it, expect } from "vitest";
import { contactSaveDecision, contactSaveHint } from "./peak-contact-action";

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
