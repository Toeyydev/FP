import { describe, it, expect } from "vitest";
import { collectPagedById } from "./peak-api";

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `C${from + i}` }));

describe("collectPagedById", () => {
  it("reads past the first page — a guide on page 2 must be mappable", () => {
    // The defect: asking for one 200-row page got PEAK's "must not exceed 100"
    // error, so the picker showed nothing at all.
    const pages = [rows(1, 100), rows(101, 100), rows(201, 30)];
    return collectPagedById(async (p) => ({ ok: true, items: pages[p - 1] ?? [] }), 100, 12).then((r) => {
      expect(r.ok).toBe(true);
      expect(r.items).toHaveLength(230);
      expect(r.pages).toBe(3);
      expect(r.truncated).toBe(false);
    });
  });

  it("stops on a short first page without asking for a second", async () => {
    let calls = 0;
    const r = await collectPagedById(async () => { calls++; return { ok: true, items: rows(1, 7) }; }, 100, 12);
    expect(calls).toBe(1);
    expect(r.items).toHaveLength(7);
    expect(r.truncated).toBe(false);
  });

  it("stops when PEAK ignores `page` and repeats itself, instead of looping", async () => {
    let calls = 0;
    const same = rows(1, 100);
    const r = await collectPagedById(async () => { calls++; return { ok: true, items: same }; }, 100, 12);
    // Two calls: the first collects, the second brings nothing new and ends it.
    expect(calls).toBe(2);
    expect(r.items).toHaveLength(100);
  });

  it("keeps the pages it already has when a later page fails, and admits it is partial", async () => {
    const r = await collectPagedById(
      async (p) => (p === 1 ? { ok: true, items: rows(1, 100) } : { ok: false, desc: "PEAK did not respond within 15s" }),
      100, 12,
    );
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(r.desc).toMatch(/did not respond/);
  });

  it("fails outright when the FIRST page fails — an empty list must not look complete", async () => {
    const r = await collectPagedById(async () => ({ ok: false, code: "E1", desc: "Bad Json Request" }), 100, 12);
    expect(r.ok).toBe(false);
    expect(r.items).toBeUndefined();
    expect(r.desc).toBe("Bad Json Request");
  });

  it("honours the page cap and says the result is truncated", async () => {
    let calls = 0;
    const r = await collectPagedById(async (p) => { calls++; return { ok: true, items: rows(p * 1000, 100) }; }, 100, 3);
    expect(calls).toBe(3);
    expect(r.items).toHaveLength(300);
    expect(r.truncated).toBe(true);
  });

  it("de-duplicates by id so an overlapping page cannot list a contact twice", async () => {
    const r = await collectPagedById(
      async (p) => (p === 1 ? { ok: true, items: rows(1, 100) } : { ok: true, items: [...rows(95, 6), ...rows(200, 3)] }),
      100, 12,
    );
    expect(r.items?.map((i) => i.id).filter((id) => id === "C95")).toHaveLength(1);
    expect(r.items).toHaveLength(103);
  });
});
