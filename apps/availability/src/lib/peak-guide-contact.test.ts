import { describe, it, expect } from "vitest";
import { guideContactPlan } from "@/lib/peak-guide-contact";
import { createContactBody, readCreatedContact } from "@/lib/peak-api";

// All data here is invented — this repo is public.

const base = { fullName: "Somchai  Testperson", taxId: "1-2345-67890-12-3", prefix: 2, address: "1 Test Road", phone: "0800000000", contacts: [] };

describe("guideContactPlan — link the supplier PEAK already has, or create one", () => {
  it("creates an individual when no contact carries the tax ID", () => {
    expect(guideContactPlan(base)).toEqual({ kind: "create", contact: { name: "Somchai Testperson", prefixNameType: 2, taxNumber: "1234567890123", address: "1 Test Road", phone: "0800000000" } });
  });
  it("links the one contact with the same 13 digits — a second supplier would split the ledger", () => {
    const contacts = [{ id: "c-1", name: "Someone Else", code: "S00001", taxNumber: "9999999999999" }, { id: "c-2", name: "Somchai T.", code: "S00002", taxNumber: "1234567890123" }];
    expect(guideContactPlan({ ...base, contacts })).toEqual({ kind: "link", contact: contacts[1] });
  });
  it("refuses when two contacts share the tax ID, or the list was cut short", () => {
    const dup = [{ id: "c-2", name: "A", code: "S00002", taxNumber: "1234567890123" }, { id: "c-3", name: "B", code: "S00003", taxNumber: "1234567890123" }];
    expect(guideContactPlan({ ...base, contacts: dup })).toMatchObject({ kind: "refuse", reasons: [expect.stringContaining("2 contacts with this tax ID (S00002, S00003)")] });
    expect(guideContactPlan({ ...base, truncated: true })).toMatchObject({ kind: "refuse", reasons: [expect.stringContaining("could not be read to the end")] });
    // …but a match on the pages that did arrive is still a match.
    expect(guideContactPlan({ ...base, truncated: true, contacts: [dup[0]] }).kind).toBe("link");
  });
  it("needs a name, 13 digits and a prefix", () => {
    const why = (o: Partial<typeof base>) => { const r = guideContactPlan({ ...base, ...o }); return r.kind === "refuse" ? r.reasons.join(" ") : ""; };
    expect(why({ fullName: " " })).toContain("no full name");
    expect(why({ taxId: "12345" })).toContain("5 digits, not 13");
    expect(why({ taxId: null as never })).toContain("no tax ID");
    expect(why({ prefix: 9 })).toContain("prefix");
  });
});

describe("PEAK Create Contact", () => {
  it("sends an individual at head office, prefix and tax number, nothing it was not given", () => {
    expect(createContactBody({ name: "Somchai Testperson", prefixNameType: 2, taxNumber: "1234567890123", address: null, phone: null })).toEqual({
      peakContacts: { contacts: [{ name: "Somchai Testperson", type: 5, prefixNameType: 2, taxNumber: "1234567890123", branchCode: "00000" }] },
    });
    expect(createContactBody({ name: "X", prefixNameType: 3, taxNumber: "1", address: "1 Test Road", phone: "080" }).peakContacts.contacts[0]).toMatchObject({ address: "1 Test Road", contactPhoneNumber: "080" });
  });
  it("reads the new id and code; a spelled-out refusal is definite, a bare 5xx is not", () => {
    expect(readCreatedContact(200, { PeakContacts: { resCode: "200", contacts: [{ id: "c-9", code: "S00009", name: "Somchai Testperson", resCode: "200" }] } })).toEqual({ ok: true, id: "c-9", code: "S00009", name: "Somchai Testperson" });
    expect(readCreatedContact(200, { PeakContacts: { resCode: "400", resDesc: "Tax number is invalid", contacts: [] } })).toEqual({ ok: false, desc: "Tax number is invalid", uncertain: false });
    expect(readCreatedContact(502, {})).toMatchObject({ ok: false, uncertain: true });
  });
});
