import { describe, it, expect } from "vitest";
import { parseReviewEmail, parseGygSubject } from "@/lib/review-parse";

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

describe("parseGygSubject — supplier + review ids from the subject line", () => {
  it("parses the standard GYG subject", () => {
    expect(parseGygSubject("You have a new review on GetYourGuide - 691771 (126357479)")).toEqual({
      supplierRef: "691771",
      sourceReviewId: "126357479",
    });
  });

  it("tolerates extra whitespace around the ids", () => {
    expect(parseGygSubject("You have a new review on GetYourGuide -  691771  ( 126357479 )")).toEqual({
      supplierRef: "691771",
      sourceReviewId: "126357479",
    });
  });

  it("yields {} on anything that doesn't match — ids are dedup keys, parse strictly", () => {
    expect(parseGygSubject("You have a new review on GetYourGuide")).toEqual({});
    expect(parseGygSubject("Re: your payout")).toEqual({});
    expect(parseGygSubject("")).toEqual({});
  });
});
