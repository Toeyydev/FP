import { describe, it, expect } from "vitest";
import { bookingZ } from "@/lib/jobsheet-schema";

// A guest's phone is read live from the booking (lib/guest-contacts) and never kept on the
// job sheet, whose guest rows are accounting evidence copied to Drive. A save that sends
// one anyway — an old client, a hand-made request — has it stripped before it is stored.
describe("job sheet guest rows never store a phone", () => {
  it("drops phone and WhatsApp fields from a saved guest row", () => {
    const row = bookingZ.parse({ name: "Guest Example", bookingNo: "GYGTEST1", bookedPax: 2, phone: "+66810100777", whatsapp: "https://wa.me/66810100777" });
    expect(row).toEqual({ name: "Guest Example", bookingNo: "GYGTEST1", bookedPax: 2, actualPax: null, tickets: "", status: "" });
    expect(JSON.stringify(row)).not.toMatch(/0100777|wa\.me/);
  });
});
