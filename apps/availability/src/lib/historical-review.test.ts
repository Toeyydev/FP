import { describe, it, expect } from "vitest";
import {
  applyAction, canReconstruct, instanceKeyFor, parseInstanceKey, isInWindow, MAY_2026,
  sanitizeAuditSnapshot, HISTORICAL_AUDIT_KEYS, missingInfo, reconstructionNote,
  type ReviewState,
} from "./historical-review";

const at = (s: Partial<ReviewState> = {}): ReviewState =>
  ({ reviewStatus: "NEEDS_REVIEW", confirmedGuideId: null, jobSheetId: null, ...s });

describe("May window — Asia/Bangkok local dates", () => {
  it("includes both boundary days", () => {
    expect(isInWindow("2026-05-01")).toBe(true);
    expect(isInWindow("2026-05-31")).toBe(true);
  });
  it("excludes the days either side", () => {
    expect(isInWindow("2026-04-30")).toBe(false);
    expect(isInWindow("2026-06-01")).toBe(false);
  });
  it("compares local date strings, so no UTC boundary can shift a day", () => {
    // 2026-05-31 23:59 Bangkok is 2026-05-31 16:59 UTC — a timestamp-based window
    // would be at risk here; a stored local date string is not.
    expect(MAY_2026).toEqual({ from: "2026-05-01", to: "2026-05-31" });
    expect(isInWindow("2026-05-31")).toBe(true);
  });
});

describe("instanceKey", () => {
  it("is date + zero-padded slot", () => {
    expect(instanceKeyFor("2026-05-13", 0)).toBe("2026-05-13#00");
    expect(instanceKeyFor("2026-05-13", 2)).toBe("2026-05-13#02");
  });
  it("is stable whether or not the product is mapped — tourId is mutable", () => {
    // Same departure, before and after product mapping assigns a tourId.
    expect(instanceKeyFor("2026-05-13", 0)).toBe(instanceKeyFor("2026-05-13", 0));
  });
  it("separates two slots on one day", () => {
    expect(instanceKeyFor("2026-05-13", 0)).not.toBe(instanceKeyFor("2026-05-13", 2));
  });
  it("round-trips", () => {
    expect(parseInstanceKey("2026-05-13#02")).toEqual({ date: "2026-05-13", slotIdx: 2 });
    expect(parseInstanceKey("nonsense")).toBeNull();
  });
});

describe("nothing is inferred", () => {
  for (const target of ["confirmOperated", "confirmCancelled", "confirmNoShow"] as const) {
    it(`${target} is reachable only by an explicit action`, () => {
      const r = applyAction(at(), target, { reason: "guest cancelled by email" });
      expect(r.ok).toBe(true);
    });
  }
  it("a fresh row starts at NEEDS_REVIEW and cannot reconstruct", () => {
    expect(canReconstruct(at())).toBe(false);
  });
});

describe("guards", () => {
  it("cancelling requires a reason", () => {
    expect(applyAction(at(), "confirmCancelled", {})).toEqual({ ok: false, error: "reason-required" });
  });
  it("excluding requires a reason", () => {
    expect(applyAction(at({ reviewStatus: "CONFIRMED_CANCELLED" }), "exclude", {})).toEqual({ ok: false, error: "reason-required" });
    const r = applyAction(at({ reviewStatus: "CONFIRMED_CANCELLED" }), "exclude", { reason: "never operated" });
    expect(r.ok && r.status).toBe("EXCLUDED");
  });
  it("readiness requires a confirmed guide", () => {
    expect(applyAction(at({ reviewStatus: "CONFIRMED_OPERATED" }), "markReady", {}))
      .toEqual({ ok: false, error: "guide-required" });
    const r = applyAction(at({ reviewStatus: "CONFIRMED_OPERATED", confirmedGuideId: "G-007" }), "markReady", {});
    expect(r.ok && r.status).toBe("READY_TO_RECONSTRUCT");
  });
  it("readiness refuses when a sheet already exists at the key", () => {
    expect(applyAction(at({ reviewStatus: "CONFIRMED_OPERATED", confirmedGuideId: "G-007" }), "markReady", { sheetExistsAtKey: true }))
      .toEqual({ ok: false, error: "sheet-already-exists" });
  });
  it("readiness refuses on an unresolved duplicate", () => {
    expect(applyAction(at({ reviewStatus: "CONFIRMED_OPERATED", confirmedGuideId: "G-007" }), "markReady", { hasUnresolvedDuplicate: true }))
      .toEqual({ ok: false, error: "unresolved-duplicate" });
  });
});

describe("reconstruction", () => {
  const ready = at({ reviewStatus: "READY_TO_RECONSTRUCT", confirmedGuideId: "G-007" });

  it("moves to RECONSTRUCTED_DRAFT", () => {
    const r = applyAction(ready, "reconstruct", {});
    expect(r.ok && r.status).toBe("RECONSTRUCTED_DRAFT");
  });
  it("cannot reconstruct twice", () => {
    expect(applyAction({ ...ready, jobSheetId: "js_1" }, "reconstruct", {}))
      .toEqual({ ok: false, error: "already-reconstructed" });
  });
  it("cannot reconstruct without a guide", () => {
    expect(applyAction(at({ reviewStatus: "READY_TO_RECONSTRUCT" }), "reconstruct", {}))
      .toEqual({ ok: false, error: "guide-required" });
  });
  it("refuses if a sheet appeared at the key in the meantime", () => {
    expect(applyAction(ready, "reconstruct", { sheetExistsAtKey: true }))
      .toEqual({ ok: false, error: "sheet-already-exists" });
  });
  it("completing requires the job sheet to be linked", () => {
    expect(applyAction(at({ reviewStatus: "RECONSTRUCTED_DRAFT" }), "complete", {}))
      .toEqual({ ok: false, error: "job-sheet-required" });
    const r = applyAction(at({ reviewStatus: "RECONSTRUCTED_DRAFT", jobSheetId: "js_1" }), "complete", {});
    expect(r.ok && r.status).toBe("COMPLETED");
  });
});

describe("changing the guide", () => {
  it("is refused after a draft exists — reverse it first", () => {
    expect(applyAction(at({ reviewStatus: "RECONSTRUCTED_DRAFT", confirmedGuideId: "G-007", jobSheetId: "js_1" }), "setGuide", { guideId: "G-016" }))
      .toEqual({ ok: false, error: "reverse-draft-first" });
  });
  it("demotes a ready row back to CONFIRMED_OPERATED — readiness must be re-earned", () => {
    const r = applyAction(at({ reviewStatus: "READY_TO_RECONSTRUCT", confirmedGuideId: "G-007" }), "setGuide", { guideId: "G-016" });
    expect(r.ok && r.status).toBe("CONFIRMED_OPERATED");
  });
  it("resolves GUIDE_UNKNOWN", () => {
    const r = applyAction(at({ reviewStatus: "GUIDE_UNKNOWN" }), "setGuide", { guideId: "G-016" });
    expect(r.ok && r.status).toBe("CONFIRMED_OPERATED");
  });
  it("a removed guide invalidates readiness", () => {
    // The FK sets confirmedGuideId to null when the guide row goes.
    expect(applyAction(at({ reviewStatus: "READY_TO_RECONSTRUCT", confirmedGuideId: null }), "reconstruct", {}))
      .toEqual({ ok: false, error: "guide-required" });
  });
});

describe("authorization", () => {
  it("reversing a draft is ADMIN-only", () => {
    const draft = at({ reviewStatus: "RECONSTRUCTED_DRAFT", confirmedGuideId: "G-007", jobSheetId: "js_1" });
    expect(applyAction(draft, "reverse", { role: "OPERATOR" })).toEqual({ ok: false, error: "admin-only" });
    const r = applyAction(draft, "reverse", { role: "ADMIN" });
    expect(r.ok && r.status).toBe("NEEDS_REVIEW");
  });
  it("reopening an exclusion is ADMIN-only", () => {
    expect(applyAction(at({ reviewStatus: "EXCLUDED" }), "reopen", { role: "OPERATOR" })).toEqual({ ok: false, error: "admin-only" });
    const r = applyAction(at({ reviewStatus: "EXCLUDED" }), "reopen", { role: "ADMIN" });
    expect(r.ok && r.status).toBe("NEEDS_REVIEW");
  });
  it("an operator may reopen an ordinary confirmation", () => {
    const r = applyAction(at({ reviewStatus: "CONFIRMED_OPERATED" }), "reopen", { role: "OPERATOR" });
    expect(r.ok && r.status).toBe("NEEDS_REVIEW");
  });
});

describe("COMPLETED is terminal", () => {
  for (const a of ["reopen", "setGuide", "reverse", "exclude", "addNote"] as const) {
    it(`refuses ${a}`, () => {
      expect(applyAction(at({ reviewStatus: "COMPLETED", jobSheetId: "js_1" }), a, { role: "ADMIN", guideId: "G-1", reason: "x" }))
        .toEqual({ ok: false, error: "completed-is-terminal" });
    });
  }
});

describe("auditSnapshot allowlist", () => {
  it("keeps only operational fields", () => {
    const s = sanitizeAuditSnapshot({
      classification: "REQUIRES_MANUAL_REVIEW", livePax: 3, warnings: ["ref used 2x"],
      channels: ["GetYourGuide"], generatedAt: "2026-09-08",
    });
    expect(s.classification).toBe("REQUIRES_MANUAL_REVIEW");
    expect(s.livePax).toBe(3);
    expect(Object.keys(s).every((k) => (HISTORICAL_AUDIT_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("drops personal data even when handed it", () => {
    const s = sanitizeAuditSnapshot({
      classification: "MISSING_ASSIGNMENT",
      customerName: "Sandra Davis", phone: "0812345678", email: "a@b.com",
      taxNumber: "1101700207366", bankAccountNo: "1234567890",
      raw: { bokun: "payload" }, token: "secret-token", notes: "call her",
    });
    const json = JSON.stringify(s);
    for (const leak of ["Sandra", "0812345678", "a@b.com", "1101700207366", "1234567890", "bokun", "secret-token"]) {
      expect(json).not.toContain(leak);
    }
    expect(s.classification).toBe("MISSING_ASSIGNMENT");
  });

  it("ignores wrongly-typed values rather than storing them", () => {
    const s = sanitizeAuditSnapshot({ livePax: "3", warnings: "not-an-array", classification: 42 });
    expect(s).toEqual({});
  });
});

describe("missingInfo + provenance", () => {
  it("names what a reviewer still owes", () => {
    expect(missingInfo(at())).toContain("guide not identified");
    expect(missingInfo(at())).toContain("operation not confirmed");
    expect(missingInfo(at({ reviewStatus: "CONFIRMED_OPERATED", confirmedGuideId: "G-007" }))).toEqual([]);
  });
  it("stamps an immutable provenance line", () => {
    const note = reconstructionNote({ instanceKey: "2026-05-13#00", by: "ops@folkpaths", at: new Date("2026-09-08T00:00:00Z") });
    expect(note).toContain("Not submitted by the guide");
    expect(note).toContain("2026-05-13#00");
  });
});
