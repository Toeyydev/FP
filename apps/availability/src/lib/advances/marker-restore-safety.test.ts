import { describe, expect, it, vi } from "vitest";
import { applyGate, healthSaysFrozen, type ApplyRequest, type DatabaseIdentity, type HealthRead } from "./marker-restore-safety";

// The remote-apply gate of the settlement-marker restore tool, with the health read mocked:
// nothing here touches a network or a database. The gate must fail closed for every missing,
// wrong, unknown or unhealthy answer, and pass only when every condition is explicit.

const remote: DatabaseIdentity = { db: "example_db", sysid: "1234567890", local: false };
const good: ApplyRequest = { apply: true, production: true, expectDatabase: "example_db", expectSystemId: "1234567890", operator: "Operator Example", healthUrl: "https://app.example.test/api/health", frozenInProcess: "1" };
const healthy = (writes: unknown = "frozen", extra: Record<string, unknown> = {}) => vi.fn<HealthRead>(async () => ({ status: 200, body: { ok: true, advances: { writes }, ...extra } }));
const refused = async (req: Partial<ApplyRequest>, read: HealthRead = healthy()) => {
  const r = await applyGate({ ...good, ...req }, remote, read);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
};

describe("remote apply fails closed", () => {
  it("1 · without --production", async () => expect(await refused({ production: false })).toMatch(/--production/));
  it("2 · without --health-url, or with a malformed one", async () => {
    expect(await refused({ healthUrl: "" })).toMatch(/--health-url/);
    expect(await refused({ healthUrl: "http://app.example.test/api/health" })).toMatch(/--health-url/);
    expect(await refused({ healthUrl: "https://app.example.test/api/health?x=1" })).toMatch(/--health-url/);
  });
  it("3 · wrong expected database name", async () => expect(await refused({ expectDatabase: "other_db" })).toMatch(/--expect-database/));
  it("4 · wrong expected system id", async () => expect(await refused({ expectSystemId: "999" })).toMatch(/--expect-system-id/));
  it("5 · ADVANCE_WRITES_FROZEN is not exactly 1 in the tool process", async () => {
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) expect(await refused({ frozenInProcess: v })).toMatch(/ADVANCE_WRITES_FROZEN=1/);
  });
  it("6 · the health endpoint is unreachable or times out", async () => {
    expect(await refused({}, async () => ({ error: "unreachable" }))).toMatch(/could not be read \(unreachable\)/);
    expect(await refused({}, async () => ({ error: "timed out" }))).toMatch(/could not be read \(timed out\)/);
  });
  it("7 · the health endpoint answers non-2xx", async () => {
    for (const status of [301, 401, 404, 500, 503]) expect(await refused({}, async () => ({ status, body: { ok: true, advances: { writes: "frozen" } } }))).toMatch(new RegExp(`HTTP ${status}`));
  });
  it("8 · the health answer is not a valid object, or the app is not healthy", async () => {
    for (const body of [null, "frozen", 1, [], { advances: { writes: "frozen" } }, { ok: "true", advances: { writes: "frozen" } }, { ok: 1, advances: { writes: "frozen" } }]) {
      expect((await applyGate(good, remote, async () => ({ status: 200, body }))).ok).toBe(false);
    }
  });
  it("9 · the health does not say frozen — missing, unknown or mis-typed values are NOT frozen", async () => {
    for (const writes of [undefined, null, "", "FROZEN", "frozen ", true, 1, "unknown", { frozen: true }]) {
      expect(await refused({}, async () => ({ status: 200, body: { ok: true, advances: { writes } } }))).toMatch(/not "frozen"|advance-writes state/);
    }
    expect(await refused({}, async () => ({ status: 200, body: { ok: true } }))).toMatch(/advance-writes state/);
  });
  it("10 · the health explicitly reports writes active", async () => {
    for (const writes of ["active", "enabled", "open"]) expect(await refused({}, healthy(writes))).toMatch(new RegExp(`writes ${writes} — freeze them first`));
  });
});

describe("the gate passes only when everything is explicit — and stops there", () => {
  it("--apply + --production + matching database and system id + operator + frozen process + healthy app reporting frozen → ok", async () => {
    const read = healthy();
    expect(await applyGate(good, remote, read)).toEqual({ ok: true });
    expect(read).toHaveBeenCalledWith("https://app.example.test/api/health");
  });
  it("the health is read only after every local condition holds", async () => {
    const read = healthy();
    await applyGate({ ...good, operator: "" }, remote, read);
    await applyGate({ ...good, frozenInProcess: "0" }, remote, read);
    expect(read).not.toHaveBeenCalled();
  });
  it("a dry run passes without any condition and never reads health", async () => {
    const read = healthy();
    expect(await applyGate({ ...good, apply: false, production: false, operator: "", frozenInProcess: undefined }, remote, read)).toEqual({ ok: true });
    expect(read).not.toHaveBeenCalled();
  });
  it("a local database needs no --production or health, but still the name, system id, operator and frozen process", async () => {
    const local = { ...remote, local: true };
    const read = healthy();
    expect(await applyGate({ ...good, production: false, healthUrl: "" }, local, read)).toEqual({ ok: true });
    expect((await applyGate({ ...good, expectSystemId: "x" }, local, read)).ok).toBe(false);
    expect((await applyGate({ ...good, frozenInProcess: "0" }, local, read)).ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it("an identity that cannot be proven refuses", async () => {
    expect((await applyGate(good, { db: "", sysid: "1", local: false }, healthy())).ok).toBe(false);
    expect((await applyGate(good, { db: "example_db", sysid: "", local: false }, healthy())).ok).toBe(false);
  });
});

describe("healthSaysFrozen — only an explicit recognised 'frozen' from a healthy app", () => {
  it("accepts exactly that", () => expect(healthSaysFrozen({ status: 200, body: { ok: true, advances: { writes: "frozen", switch: "on" } } })).toEqual({ ok: true }));
  it("rejects a 2xx that is not healthy", () => expect(healthSaysFrozen({ status: 204, body: null }).ok).toBe(false));
});
