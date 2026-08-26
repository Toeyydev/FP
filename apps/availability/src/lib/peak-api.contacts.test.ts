import { describe, it, expect } from "vitest";
import { parsePeakContacts } from "@/lib/peak-api";

// Folkpaths already has its guides in PEAK, so this list is what an operator LINKS
// to. Getting it wrong means either an empty picker or — worse — someone pasting an
// id by hand and mistyping it.
describe("PEAK contact-list parsing", () => {
  const contacts = [
    { id: "ct-1", name: "Nattaporn Srisai", code: "V-0012", taxNumber: "3100900001234", type: 5 },
    { id: "ct-2", name: "Test FreeFlow", taxNumber: "1234567890123" },
  ];

  it("reads the documented shape", () => {
    const r = parsePeakContacts({ peakContacts: { contacts } });
    expect("contacts" in r && r.contacts.map((c) => c.id)).toEqual(["ct-1", "ct-2"]);
  });

  it("reads the capitalised wrapper PEAK returns on responses", () => {
    const r = parsePeakContacts({ PeakContacts: { contacts } });
    expect("contacts" in r && r.contacts).toHaveLength(2);
  });

  it("keeps the tax number, which is how two same-named guides are told apart", () => {
    const r = parsePeakContacts({ peakContacts: { contacts } });
    if (!("contacts" in r)) throw new Error("expected contacts");
    expect(r.contacts[0]).toEqual({ id: "ct-1", name: "Nattaporn Srisai", code: "V-0012", taxNumber: "3100900001234", type: "5" });
  });

  it("drops entries with no id — the id is the whole point of the mapping", () => {
    const r = parsePeakContacts({ peakContacts: { contacts: [...contacts, { name: "no id" }] } });
    expect("contacts" in r && r.contacts).toHaveLength(2);
  });

  it("an unrecognised shape is an error naming the keys seen, never silence", () => {
    const r = parsePeakContacts({ peakContacts: { totalContact: 2 } });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("totalContact");
  });

  it("never leaks a contact's details into the diagnostic", () => {
    // Contact records are PII — a parsing error must not spill names or tax numbers.
    const r = parsePeakContacts({ peakContacts: { odd: "Nattaporn Srisai 3100900001234" } });
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error).toContain("odd");
    expect(r.error).not.toContain("Nattaporn");
    expect(r.error).not.toContain("3100900001234");
  });
});
