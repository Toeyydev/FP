import { describe, it, expect } from "vitest";
import { parseReviewEmail } from "@/lib/review-parse";

describe("parseReviewEmail — GetYourGuide notification", () => {
  const email = `Hi supply partner,

You have received a new review for your product Bangkok: Half-Day Guided: Grand Palace, Wat Pho & Wat Arun.

★★★★★
Great tour guide!`;

  it("extracts product, stars, and comment", () => {
    const p = parseReviewEmail(email);
    expect(p.product).toBe("Bangkok: Half-Day Guided: Grand Palace, Wat Pho & Wat Arun");
    expect(p.stars).toBe(5);
    expect(p.comment).toBe("Great tour guide!");
  });

  it("handles markdown-bolded product names and a textual rating", () => {
    const p = parseReviewEmail("You have received a new review for your product **Wat Arun Sunset Tour**.\n\n5 stars\nAmazing!");
    expect(p.product).toBe("Wat Arun Sunset Tour");
    expect(p.stars).toBe(5);
    expect(p.comment).toBe("Amazing!");
  });

  it("returns an empty object for unrelated text", () => {
    const p = parseReviewEmail("just some random note");
    expect(p.product).toBeUndefined();
    expect(p.stars).toBeUndefined();
  });
});
