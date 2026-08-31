import { describe, it, expect } from "vitest";
import {
  buildConfirmation, confirmationSubject, confirmationText, confirmationHtml,
  bookingIcs, icsTimestamp, longDate, money, DEFAULT_PAYMENT_NOTE,
} from "@/lib/booking-confirmation";

const base = {
  voucherCode: "FP-4DTTHH",
  tourName: "Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun",
  date: "2026-09-10", time: "08:30",
  pax: 3, adults: 2, children: 1,
  customerName: "Anna Müller",
  meetingPoint: "Tha Chang Pier, Gate 1",
  total: 3900, currency: "THB", durationMin: 360,
};

describe("subject", () => {
  it("leads with the code, so it survives inbox truncation", () => {
    expect(confirmationSubject(base)).toBe(
      "FP-4DTTHH · Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun · Thu 10 Sep 08:30");
  });
  it("keeps the code visible in the first 40 characters an inbox shows", () => {
    expect(confirmationSubject(base).slice(0, 40)).toContain("FP-4DTTHH");
  });
  it("uses the short date in the subject and the long one in the body", () => {
    expect(confirmationSubject(base)).toContain("Thu 10 Sep");
    expect(confirmationText(base)).toContain("Thursday 10 September 2026");
  });
});

describe("plain text", () => {
  const t = confirmationText(base);
  it("stands on its own — code, tour, when, party, place, total", () => {
    expect(t).toContain("BOOKING CODE: FP-4DTTHH");
    expect(t).toContain("Thursday 10 September 2026 at 08:30");
    expect(t).toContain("2 adults, 1 child");
    expect(t).toContain("Tha Chang Pier, Gate 1");
    expect(t).toContain("฿3,900");
  });
  it("greets by first name", () => { expect(t.startsWith("Hi Anna,")).toBe(true); });
  it("falls back to the whole name when there is no space", () => {
    expect(confirmationText({ ...base, customerName: "Somchai" }).startsWith("Hi Somchai,")).toBe(true);
  });
  it("states the payment position", () => { expect(t).toContain(DEFAULT_PAYMENT_NOTE); });
  it("honours a custom payment note", () => {
    expect(confirmationText({ ...base, paymentNote: "Paid in full — thank you." })).toContain("Paid in full");
  });
  it("pluralises a party of one correctly", () => {
    expect(confirmationText({ ...base, adults: 1, children: 0, pax: 1 })).toContain("1 adult\n");
  });
  it("says children, not childs", () => {
    expect(confirmationText({ ...base, adults: 0, children: 2, pax: 2 })).toContain("2 children");
  });
  it("falls back to a guest count when the breakdown is unknown", () => {
    expect(confirmationText({ ...base, adults: null, children: null, pax: 4 })).toContain("4 guests");
  });
  it("omits the total line entirely rather than printing an empty one", () => {
    expect(confirmationText({ ...base, total: null })).not.toContain("Total:");
  });
});

describe("html", () => {
  const h = confirmationHtml(base);
  it("escapes guest-supplied text", () => {
    const evil = confirmationHtml({ ...base, customerName: '<script>alert("x")</script>' });
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;script&gt;");
  });
  it("uses table layout, not flex or grid, so it survives Outlook", () => {
    expect(h).not.toMatch(/display:\s*(flex|grid)/);
    expect(h).toContain("<table");
  });
  it("shows the code", () => { expect(h).toContain("FP-4DTTHH"); });
});

describe("calendar invite", () => {
  it("converts Bangkok wall-clock to UTC exactly", () => {
    // 08:30 in Bangkok (UTC+7) is 01:30 UTC the same day.
    expect(icsTimestamp("2026-09-10", "08:30")).toBe("20260910T013000Z");
  });
  it("rolls back a day when the local time is before 07:00", () => {
    expect(icsTimestamp("2026-09-10", "06:00")).toBe("20260909T230000Z");
  });
  it("adds the duration to get the end", () => {
    expect(icsTimestamp("2026-09-10", "08:30", 360)).toBe("20260910T073000Z");
  });
  it("builds a valid VEVENT", () => {
    const ics = bookingIcs(base, new Date("2026-08-31T00:00:00Z"))!;
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20260910T013000Z");
    expect(ics).toContain("DTEND:20260910T073000Z");
    expect(ics).toContain("UID:FP-4DTTHH@folkpaths.com");
    expect(ics).toContain("LOCATION:Tha Chang Pier\\, Gate 1"); // comma escaped per RFC 5545
    expect(ics.endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("\r\n"); // CRLF line endings are required
  });
  it("defaults to six hours when the tour has no duration", () => {
    expect(bookingIcs({ ...base, durationMin: null })!).toContain("DTEND:20260910T073000Z");
  });
  it("returns null rather than a malformed invite", () => {
    expect(bookingIcs({ ...base, date: "soon" })).toBeNull();
    expect(bookingIcs({ ...base, time: "" })).toBeNull();
  });
  it("omits LOCATION when there is no meeting point", () => {
    expect(bookingIcs({ ...base, meetingPoint: null })!).not.toContain("LOCATION:");
  });
});

describe("formatting helpers", () => {
  it("writes a long date", () => { expect(longDate("2026-09-01")).toBe("Tuesday 1 September 2026"); });
  it("passes junk through untouched", () => { expect(longDate("nope")).toBe("nope"); });
  it("formats baht", () => { expect(money(3900)).toBe("฿3,900"); });
  it("names a non-baht currency", () => { expect(money(120, "USD")).toBe("120 USD"); });
  it("returns empty for a missing amount", () => { expect(money(null)).toBe(""); });
});

describe("buildConfirmation", () => {
  it("returns all four parts", () => {
    const c = buildConfirmation(base);
    expect(c.subject).toContain("FP-4DTTHH");
    expect(c.text.length).toBeGreaterThan(80);
    expect(c.html).toContain("<table");
    expect(c.ics).toContain("BEGIN:VCALENDAR");
  });
});
