import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expenseZ } from "@/lib/jobsheet-schema";
import { stampPayerActor, type PayerRuleRow } from "@/lib/payer-rules";
import { claimsServerOwned, financialIdentity, isProtected, mergeServerOwned, stripServerOwned, SERVER_OWNED_ROW_FIELDS, type ProtectedRow } from "@/lib/protected-expense-fields";

// A save used to be able to destroy an admin's signature without saying anything.
//
// `expenseZ` lists every field a browser may send, and zod deletes the rest in silence.
// `evidenceWaiver`, `paidByBy` and `paidByAt` were never listed, so the row that came
// back from the client had none of them, and that row was what got written. Pressing
// Save on an unchanged sheet was enough: every waiver on it vanished, every payer stamp
// re-pointed at whoever pressed the button, and no error appeared anywhere.
//
// All data invented — this repo is public.

const waiver = { by: "u_admin", at: "2099-04-01T03:00:00.000Z", reason: "the ferry operator issues no printed ticket" };
const row = (over: Partial<ProtectedRow> = {}): ProtectedRow =>
  ({ description: "Ferry", price: 11, pax: 4, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over } as ProtectedRow);
const waived = (over: Partial<ProtectedRow> = {}) => row({ evidenceWaiver: waiver, ...over });
const stamped = (over: Partial<ProtectedRow> = {}) => row({ paidByBy: "u_admin", paidByAt: "2099-04-01T03:00:00.000Z", ...over });

describe("the bug this fixes", () => {
  it("the save schema still does not carry these fields — which is why the server has to", () => {
    const out = expenseZ.parse(waived({ paidByBy: "u_admin", paidByAt: "2099-04-01T03:00:00.000Z" })) as Record<string, unknown>;
    for (const f of SERVER_OWNED_ROW_FIELDS) expect(Object.keys(out)).not.toContain(f);
    expect(out.paidBySource).toBe("operator"); // the client's own fields are untouched
  });

  it("an unchanged save keeps the waiver byte for byte", () => {
    const stored = [waived()];
    const fromBrowser = [row()]; // what the editor sends back: the row, minus what zod dropped
    const { rows, conflicts } = mergeServerOwned(stored, fromBrowser);
    expect(conflicts).toEqual([]);
    expect(JSON.stringify(rows[0].evidenceWaiver)).toBe(JSON.stringify(waiver));
  });

  it("an unchanged save keeps who recorded the payer, and when", () => {
    const { rows } = mergeServerOwned([stamped()], [row()]);
    expect(rows[0].paidByBy).toBe("u_admin");
    expect(rows[0].paidByAt).toBe("2099-04-01T03:00:00.000Z");
  });

  it("the person pressing Save does not become the person who recorded the payer", () => {
    const { rows } = mergeServerOwned([stamped()], [row()]);
    const after = stampPayerActor(rows as PayerRuleRow[], "u_someone_else") as ProtectedRow[];
    expect(after[0].paidByBy).toBe("u_admin");
    expect(after[0].paidByAt).toBe("2099-04-01T03:00:00.000Z");
  });

  it("a row nobody stamped still gets stamped, as it always did", () => {
    const { rows } = mergeServerOwned([row()], [row()]);
    const after = stampPayerActor(rows as PayerRuleRow[], "u_operator") as ProtectedRow[];
    expect(after[0].paidByBy).toBe("u_operator");
  });
});

describe("nothing the client sends is believed", () => {
  it("a waiver in the request body is thrown away", () => {
    const forged = [row({ evidenceWaiver: { by: "u_guide", at: "2099-04-01T03:00:00.000Z", reason: "I accept my own expense, thanks" } })];
    expect(claimsServerOwned(forged)).toBe(true);
    expect(stripServerOwned(forged)[0].evidenceWaiver).toBeUndefined();
    // …and the merge writes only what the database already held.
    const { rows } = mergeServerOwned([row()], forged);
    expect(rows[0].evidenceWaiver).toBeUndefined();
  });

  it("an actor and a time in the request body are thrown away", () => {
    const forged = [row({ paidByBy: "u_someone_important", paidByAt: "2001-01-01T00:00:00.000Z" })];
    const { rows } = mergeServerOwned([row()], forged);
    expect(rows[0].paidByBy).toBeUndefined();
    expect(rows[0].paidByAt).toBeUndefined();
  });

  it("a client cannot overwrite a REAL waiver with one of its own", () => {
    const forged = [row({ evidenceWaiver: { by: "u_guide", at: "2099-01-01T00:00:00.000Z", reason: "changed to something more convenient" } })];
    const { rows } = mergeServerOwned([waived()], forged);
    expect(JSON.stringify(rows[0].evidenceWaiver)).toBe(JSON.stringify(waiver));
  });

  it("a plain save is not accused of forging anything", () => {
    expect(claimsServerOwned([row(), row({ description: "Bus" })])).toBe(false);
  });
});

describe("a signed-for row cannot be changed by a save", () => {
  const refused = (stored: ProtectedRow[], incoming: ProtectedRow[]) => mergeServerOwned(stored, incoming).conflicts;

  it("deleting it is refused", () => {
    const r = refused([waived(), row({ description: "Bus" })], [row({ description: "Bus" })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Ferry");
    expect(r[0]).toContain("waiver");
  });

  it("repricing it is refused", () => {
    expect(refused([waived()], [row({ price: 25 })])[0]).toContain("different expense");
  });

  it("renaming it is refused", () => {
    expect(refused([waived()], [row({ description: "Boat" })])).toHaveLength(1);
  });

  it("changing who paid it is refused — that is the whole question a receipt answers", () => {
    expect(refused([waived()], [row({ paidBy: "company" })])).toHaveLength(1);
  });

  it("reordering it is refused, rather than letting the waiver follow the position", () => {
    const bus = row({ description: "Bus", price: 15 });
    const r = refused([waived(), bus], [bus, row()]);
    expect(r).toHaveLength(1);
    // The waiver must NOT have landed on the bus.
    const { rows } = mergeServerOwned([waived(), bus], [bus, row()]);
    expect(rows[0].evidenceWaiver).toBeUndefined();
  });

  it("a row carrying only a payer stamp is protected too", () => {
    expect(refused([stamped()], [row({ price: 99 })])[0]).toContain("recorded payer");
  });

  it("the refusal says which row and what changed, so it can be acted on", () => {
    const r = refused([waived()], [row({ price: 25 })])[0];
    expect(r).toContain("Row 1");
    expect(r).toMatch(/4×11/);
    expect(r).toMatch(/4×25/);
  });

  it("an unprotected row can still be renamed, repriced, reordered and deleted", () => {
    const a = row({ description: "Water", price: 10 }), b = row({ description: "Bus", price: 15 });
    const { rows, conflicts } = mergeServerOwned([a, b], [b, row({ description: "Snacks", price: 40 })]);
    expect(conflicts).toEqual([]);
    expect(rows.map((r) => r.description)).toEqual(["Bus", "Snacks"]);
  });

  it("adding rows around a protected one is fine, as long as it stays put", () => {
    const { conflicts } = mergeServerOwned([waived()], [row(), row({ description: "Snacks", price: 40 })]);
    expect(conflicts).toEqual([]);
  });
});

describe("what counts as the same expense", () => {
  it("whitespace is not a change", () => {
    expect(financialIdentity(row({ description: "  Ferry   fare " }))).toBe(financialIdentity(row({ description: "Ferry fare" })));
  });
  it("money is compared to the satang, not by floating point luck", () => {
    expect(financialIdentity(row({ price: 0.1 + 0.2 }))).toBe(financialIdentity(row({ price: 0.3 })));
  });
  it("a different price, count, kind or payer is a different expense", () => {
    const base = financialIdentity(row());
    for (const over of [{ price: 12 }, { pax: 5 }, { expenseType: "meal" }, { paidBy: "advance" }] as Partial<ProtectedRow>[]) {
      expect(financialIdentity(row(over))).not.toBe(base);
    }
  });
  it("a malformed waiver does not make a row protected", () => {
    expect(isProtected(row({ evidenceWaiver: "yes please" as unknown as object }))).toBe(false);
    expect(isProtected(row({ paidByBy: "   " }))).toBe(false);
    expect(isProtected(row())).toBe(false);
  });
});

describe("the sheet the field list is kept in step with", () => {
  it("every server-owned field is absent from expenseZ on purpose", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/jobsheet-schema.ts"), "utf8");
    const body = src.slice(src.indexOf("const expenseZ"), src.indexOf("const guideFeeZ"));
    for (const f of SERVER_OWNED_ROW_FIELDS) {
      expect(body, `${f} must not be accepted from the client — it is carried server-side instead`).not.toContain(`${f}:`);
    }
  });

  it("the save route carries them rather than trusting the body", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/jobsheet/route.ts"), "utf8");
    expect(route).toContain("stripServerOwned");
    expect(route).toContain("mergeServerOwned");
    // Stamped after the merge, never before — otherwise the saver overwrites the recorder.
    expect(route.indexOf("mergeServerOwned")).toBeLessThan(route.lastIndexOf("stampPayerActor"));
  });
});
