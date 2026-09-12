import { describe, it, expect } from "vitest";
import { availabilitySaveError } from "./availability-errors";

// Every rejection PUT /api/availability can return has to reach the guide as
// something they can act on. The fallback matters most: an unrecognised failure
// must still say "not saved" rather than pass for success.

describe("availabilitySaveError", () => {
  it("tells a signed-out guide to sign in again", () => {
    expect(availabilitySaveError(401, "unauthorized")).toBe("saveFailedSignedOut");
  });

  it("sends an incomplete profile to the profile form", () => {
    expect(availabilitySaveError(403, "profile-incomplete")).toBe("completeProfileFirst");
  });

  it("explains a blocked day instead of blaming the guide", () => {
    expect(availabilitySaveError(409, "date-blocked")).toBe("dayBlocked");
  });

  it("falls back to a plain failure for anything unrecognised", () => {
    expect(availabilitySaveError(400, "bad body")).toBe("saveFailed");
    expect(availabilitySaveError(403, "guides only")).toBe("saveFailed");
    expect(availabilitySaveError(500, null)).toBe("saveFailed");
    expect(availabilitySaveError(502)).toBe("saveFailed");
  });

  it("does not read an error code on the wrong status", () => {
    // A 500 carrying a stale body must not be reported as a blocked day.
    expect(availabilitySaveError(500, "date-blocked")).toBe("saveFailed");
    expect(availabilitySaveError(403, "date-blocked")).toBe("saveFailed");
  });
});
