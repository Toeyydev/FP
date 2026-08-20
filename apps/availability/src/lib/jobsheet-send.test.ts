import { describe, it, expect } from "vitest";
import { paymentBubble } from "@/lib/jobsheet-send";

const JOBS = [
  { dateLabel: "7 Jul", time: "13:30", tour: "Grand Palace, Wat Pho & Wat Arun", expenses: 1280, fee: 970, total: 2250 },
  { dateLabel: "8 Jul", time: "08:30", tour: "Grand Palace, Wat Pho & Wat Arun", expenses: 665, fee: 970, total: 1635 },
  { dateLabel: "14 Jul", time: "08:30", tour: "Grand Palace, Wat Pho & Wat Arun", expenses: 881, fee: 970, total: 1851 },
];
const TOTAL = 5736;

// Walk every component in the bubble.
function walk(node: unknown, visit: (n: Record<string, unknown>) => void) {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string") visit(n);
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object") walk(v, visit);
  }
}

const texts = (bubble: unknown) => {
  const out: string[] = [];
  walk(bubble, (n) => {
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    if (n.type === "span" && typeof n.text === "string") out.push(n.text);
  });
  return out;
};

describe("paymentBubble", () => {
  const bubble = paymentBubble("💸 July 2026 payment transferred", JOBS, TOTAL, "https://drive.google.com/file/d/abc123/view-e-slip");

  it("heads with the month and the total over the tour count", () => {
    const t = texts(bubble);
    expect(t).toContain("💸 July 2026 payment transferred");
    expect(t).toContain("฿5,736");
    expect(t).toContain("  |  3 tours");
  });

  it("lays every paid tour out as a row of date/time, tour, expenses, fee, total", () => {
    const t = texts(bubble);
    expect(t).toContain("7 Jul\n13:30");
    expect(t).toContain("14 Jul\n08:30");
    // 8 Jul: expenses ฿665 + fee ฿970 = ฿1,635.
    expect(t).toContain("฿665");
    expect(t).toContain("฿1,635");
    // The per-tour totals must add up to the headline total.
    expect(JOBS.reduce((s, j) => s + j.total, 0)).toBe(TOTAL);
    expect(JOBS.every((j) => j.expenses + j.fee === j.total)).toBe(true);
  });

  it("links the bank slip and the pay page", () => {
    const uris: string[] = [];
    walk(bubble, (n) => {
      const a = n.action as Record<string, unknown> | undefined;
      if (a?.type === "uri") uris.push(String(a.uri));
    });
    expect(uris).toContain("https://drive.google.com/file/d/abc123/view-e-slip");
    expect(uris).toContain("https://ops.folkpaths.com/pay");
    // Every link LINE will accept must be https.
    expect(uris.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("omits the slip line when no slip was uploaded", () => {
    const t = texts(paymentBubble("💸 Payment transferred", JOBS, TOTAL));
    expect(t.some((s) => s.startsWith("Bank slip"))).toBe(false);
    expect(t).toContain("Payment details & job sheets: ");
  });

  it("rolls a long month up rather than growing the bubble without limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...JOBS[0], dateLabel: `${i + 1} Jul` }));
    const t = texts(paymentBubble("💸 July 2026 payment transferred", many, 45000));
    expect(t).toContain("+ 8 more tours — see the full list on your pay page.");
    expect(t).toContain("1 Jul\n13:30");
    expect(t.some((s) => s.startsWith("13 Jul"))).toBe(false); // past the 12-row cap
    expect(JSON.stringify(paymentBubble("h", many, 45000)).length).toBeLessThan(30_000); // LINE's message cap
  });

  it("builds components LINE will accept", () => {
    walk(bubble, (n) => {
      // A text is either a plain string or styled spans — never both, never neither.
      if (n.type === "text") expect(typeof n.text === "string" !== Array.isArray(n.contents)).toBe(true);
      // Flex sizes are keywords, not numbers.
      if (n.size != null && n.type === "text") expect(typeof n.size).toBe("string");
      // Colours must be hex; LINE drops the component otherwise.
      if (typeof n.color === "string") expect(n.color).toMatch(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
    });
  });
});
