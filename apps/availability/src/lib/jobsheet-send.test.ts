import { describe, it, expect } from "vitest";
import { paymentFlex, type PaymentRow } from "@/lib/jobsheet-send";

const rows: PaymentRow[] = [
  { when: "Mon 7 Jul · 13:30", tour: "Grand Palace, Wat Pho & Wat Arun", exp: 1280, fee: 970, grand: 2250, hasSheet: true, reported: null },
  { when: "Tue 8 Jul · 08:30", tour: "Grand Palace, Wat Pho & Wat Arun", exp: 665, fee: 970, grand: 1635, hasSheet: true, reported: null },
];

describe("paymentFlex — LINE table bubble", () => {
  it("builds a bubble: header total, a row per tour, a totals row, and both buttons", () => {
    const b = paymentFlex({ scope: "July 2026", rows, total: 3885, totExp: 1945, totFee: 1940, count: 2, slipUrl: "https://drive/x", payUrl: "https://guide.folkpaths.com/pay" }) as any;
    expect(b.type).toBe("bubble");
    const header = JSON.stringify(b.header);
    expect(header).toContain("฿3,885");
    expect(header).toContain("2 tours paid");
    expect(header).toContain("July 2026");
    expect(b.body.contents).toHaveLength(6); // colHead + separator + 2 rows + separator + totals
    expect(JSON.stringify(b.body)).toContain("฿2,250");
    expect(JSON.stringify(b.body)).not.toContain(".00");
    const footer = JSON.stringify(b.footer);
    expect(footer).toContain("Bank slip");
    expect(footer).toContain("https://guide.folkpaths.com/pay");
    expect(footer).not.toContain("expreview"); // no review buttons without a period
  });

  it("omits the bank-slip button with no slip, and shows — for a tour with no sheet", () => {
    const b = paymentFlex({ rows: [{ when: "Mon 1 Jul · 08:30", tour: "T", exp: 0, fee: 0, grand: 500, hasSheet: false, reported: null }], total: 500, totExp: 0, totFee: 0, count: 1, payUrl: "https://p" }) as any;
    const footer = JSON.stringify(b.footer);
    expect(footer).toContain("Full details");
    expect(footer).not.toContain("Bank slip");
    expect(JSON.stringify(b.body)).toContain("—");
    expect(JSON.stringify(b.header)).toContain("1 tour paid");
  });

  it("adds the review (postback) buttons only when a period is given", () => {
    const withP = JSON.stringify(paymentFlex({ rows, total: 3885, totExp: 1945, totFee: 1940, count: 2, payUrl: "https://p", period: "2026-07" }));
    expect(withP).toContain("expreview:ok:2026-07");
    expect(withP).toContain("expreview:off:2026-07");
    expect(withP).toContain("Looks right");
    expect(withP).toContain("Something's off");
    const noP = JSON.stringify(paymentFlex({ rows, total: 3885, totExp: 1945, totFee: 1940, count: 2, payUrl: "https://p" }));
    expect(noP).not.toContain("expreview");
  });

  it("shows the guide's reported total as a review line, flagging a mismatch", () => {
    const match: PaymentRow = { when: "d", tour: "t", exp: 881, fee: 970, grand: 1851, hasSheet: true, reported: 881 };
    const off: PaymentRow = { when: "d", tour: "t", exp: 881, fee: 970, grand: 1851, hasSheet: true, reported: 920 };
    const bMatch = JSON.stringify(paymentFlex({ rows: [match], total: 1851, totExp: 881, totFee: 970, count: 1, payUrl: "https://p" }));
    const bOff = JSON.stringify(paymentFlex({ rows: [off], total: 1851, totExp: 881, totFee: 970, count: 1, payUrl: "https://p" }));
    expect(bMatch).toContain("you reported ฿881 ✓");
    expect(bOff).toContain("you reported ฿920 — check");
    expect(bOff).toContain("#B26A00"); // amber highlight on mismatch
  });

  it("shows no review line when the guide didn't report expenses", () => {
    const b = JSON.stringify(paymentFlex({ rows, total: 3885, totExp: 1945, totFee: 1940, count: 2, payUrl: "https://p" }));
    expect(b).not.toContain("you reported");
  });
});
