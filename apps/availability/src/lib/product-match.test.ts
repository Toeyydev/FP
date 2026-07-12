import { describe, it, expect } from "vitest";
import { matchTourByProduct } from "@/lib/product-match";

// The actual ProductMap rows from production, plus a T-003 tour to test disambiguation.
const CANDIDATES = [
  { name: "Bangkok : Grand Palace, Wat Pho & Wat Arun Guided Experience", tourId: "T-001" },
  { name: "Bangkok's Classic : Grand Palace , Wat Pho and Wat Arun Guided Tour", tourId: "T-001" },
  { name: "GetYourGuide", tourId: "T-001" },
  { name: "Viator.com", tourId: "T-001" },
  { name: "Wat Pho & Wat Arun Guided Tour", tourId: "T-003" },
];

describe("matchTourByProduct", () => {
  it("resolves the review email's title variant to T-001", () => {
    // This exact string is NOT in ProductMap — fuzzy match must still find T-001.
    expect(matchTourByProduct("Bangkok: Half-Day Guided: Grand Palace, Wat Pho & Wat Arun", CANDIDATES)).toBe("T-001");
  });

  it("does not let the shorter T-003 subset beat the fuller T-001 match", () => {
    expect(matchTourByProduct("Grand Palace, Wat Pho & Wat Arun", CANDIDATES)).toBe("T-001");
  });

  it("matches a genuine Wat Pho & Wat Arun-only tour to T-003", () => {
    expect(matchTourByProduct("Wat Pho and Wat Arun Evening Tour", CANDIDATES)).toBe("T-003");
  });

  it("returns null for a bare channel label (no identifying tokens)", () => {
    expect(matchTourByProduct("GetYourGuide", CANDIDATES)).toBeNull();
  });

  it("returns null for an unrelated product", () => {
    expect(matchTourByProduct("Chiang Mai Elephant Sanctuary Day Trip", CANDIDATES)).toBeNull();
  });
});
