import { describe, it, expect } from "vitest";
import { paymentFlex, type PaymentRow } from "@/lib/jobsheet-send";

const rows: PaymentRow[] = [
  { when: "Mon 7 Jul · 13:30", tour: "Grand Palace, Wat Pho & Wat Arun", exp: 1280, fee: 970, grand: 2250, hasSheet: true },
  { when: "Tue 8 Jul · 08:30", tour: "Grand Palace, Wat Pho & Wat Arun", exp: 665, fee: 970, grand: 1635, hasSheet: true },
];

describe("paymentFlex — LINE table bubble", () => {
  it("builds a bubble: header total, a row per tour, a totals row, and both buttons", () => {
    const b = paymentFlex({ scope: "July 2026", rows, total: 3885, totExp: 1945, totFee: 1940, count: 2, slipUrl: "https://drive/x", payUrl: "https://guide.folkpaths.com/pay" }) as any;
    expect(b.type).toBe("bubble");
    const header = JSON.stringify(b.header);
    expect(header).toContain("฿3,885");
    expect(header).toContain("2 tours paid");
    expect(header).toContain("July 2026");
    // colHead + separator + 2 rows + separator + totals row = 6
    expect(b.body.contents).toHaveLength(6);
    // whole baht, no decimals
    expect(JSON.stringify(b.body)).toContain("฿2,250");
    expect(JSON.stringify(b.body)).not.toContain(".00");
    // both link buttons (bank slip + full details)
    expect(b.footer.contents).toHaveLength(2);
    expect(JSON.stringify(b.footer)).toContain("https://guide.folkpaths.com/pay");
  });

  it("omits the bank-slip button with no slip, and shows — for a tour with no sheet", () => {
    const b = paymentFlex({ rows: [{ when: "Mon 1 Jul · 08:30", tour: "T", exp: 0, fee: 0, grand: 500, hasSheet: false }], total: 500, totExp: 0, totFee: 0, count: 1, payUrl: "https://p" }) as any;
    expect(b.footer.contents).toHaveLength(1); // only "Full details"
    expect(JSON.stringify(b.body)).toContain("—"); // dashes for exp/fee when no sheet
    expect(JSON.stringify(b.header)).toContain("1 tour paid");
  });
});
