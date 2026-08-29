import { describe, it, expect } from "vitest";
import { PUBLIC_BASE_URL, PUBLIC_HOST, siteUrl } from "@/lib/site";

describe("public base URL", () => {
  it("defaults to the current domain when PUBLIC_BASE_URL is unset", () => {
    // Nothing moves until someone deliberately sets the variable — a half-applied
    // rename would send guides one-tap job links to a host that does not answer.
    expect(PUBLIC_BASE_URL).toBe("https://ops.folkpaths.com");
    expect(PUBLIC_HOST).toBe("ops.folkpaths.com");
  });

  it("builds absolute URLs with or without a leading slash", () => {
    expect(siteUrl("/pay")).toBe("https://ops.folkpaths.com/pay");
    expect(siteUrl("pay")).toBe("https://ops.folkpaths.com/pay");
    expect(siteUrl()).toBe("https://ops.folkpaths.com/");
  });
});
