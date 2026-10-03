import { describe, expect, it } from "vitest";
import { ARCHIVED_NOTE, bangkokDay, planRestore, toBokunItem, type BokunItem, type Candidate } from "@/lib/archived-restore";

// Which archived bookings come back. All data invented — this repo is public.

const TODAY = "2099-09-01";
const ARCHIVED_BEFORE = "2099-06-15";
let n = 0;
const row = (over: Partial<Candidate> = {}): Candidate => ({
  id: `b${++n}`, source: "GetYourGuide", confirmationCode: `FOLK-T${1000 + n}`, externalRef: `GYGTEST${n}`, status: "IGNORED",
  date: "2099-04-10", slotIdx: 0, tourId: "T-900", pax: 2, notes: null, assignedGuideId: null, ...over,
});
const bk = (r: Candidate, over: Partial<BokunItem> = {}): BokunItem => ({ productCode: r.confirmationCode, bookingCode: `GET-${r.id}`, ext: r.externalRef, status: "CONFIRMED", day: r.date, ...over });
const plan = (rows: Candidate[], bokun: BokunItem[]) => planRestore(rows, bokun, TODAY, ARCHIVED_BEFORE);

describe("what comes back", () => {
  it("a booking Bókun has as CONFIRMED, ARRIVED or NO_SHOW on the same day", () => {
    const rs = [row(), row(), row()];
    const p = plan(rs, [bk(rs[0]), bk(rs[1], { status: "ARRIVED" }), bk(rs[2], { status: "NO_SHOW" })]);
    expect(p.restore.map((r) => r.id)).toEqual(rs.map((r) => r.id));
    expect(p.exceptions).toEqual([]);
  });

  it("not one Bókun cancelled, or has nowhere, or has on another day", () => {
    const rs = [row(), row(), row()];
    const p = plan(rs, [bk(rs[0], { status: "CANCELLED" }), bk(rs[2], { day: "2099-04-11" })]);
    expect(p.restore).toEqual([]);
    expect(p.exceptions.map((e) => e.reason)).toEqual(["Bókun says CANCELLED", "Bókun has no booking for it on this date", "Bókun has it on 2099-04-11"]);
  });

  it("not one hidden by hand: a note, a guide, or dated after Archive stale ran", () => {
    const rs = [row({ notes: "duplicate (example)" }), row({ assignedGuideId: "G-900" }), row({ date: "2099-06-20" })];
    const p = plan(rs, rs.map((r) => bk(r)));
    expect(p.restore).toEqual([]);
    expect(p.exceptions.map((e) => e.reason)).toEqual(["hidden by hand (it has a note)", "hidden by hand (it has a guide)", "not hidden by Archive stale (dated after it ran)"]);
  });

  it("a booking Archive stale marked comes back whatever its date", () => {
    const r = row({ date: "2099-07-20", notes: `${ARCHIVED_NOTE} 2099-08-01` });
    expect(plan([r], [bk(r)]).restore.map((x) => x.id)).toEqual([r.id]);
  });

  it("nothing at all when no Archive stale run is on record", () => {
    const r = row();
    expect(planRestore([r], [bk(r)], TODAY, null).restore).toEqual([]);
  });

  it("not a live booking, not a future one, not one without a tour or departure", () => {
    const rs = [row({ status: "PENDING" }), row({ date: "2099-09-05" }), row({ tourId: null }), row({ slotIdx: null })];
    const p = plan(rs, rs.map((r) => bk(r)));
    expect(p.restore).toEqual([]);
    expect(p.exceptions.map((e) => e.reason)).toEqual(["not a past tour", "no tour or departure", "no tour or departure"]);
  });
});

describe("one booking, one place on the board", () => {
  it("the search copy (GET-…) is matched through Bókun's booking code, and needs every product that day confirmed", () => {
    const search = row({ confirmationCode: "GET-90000001", externalRef: "GYGORDER1" });
    const ok = plan([search], [{ productCode: "FOLK-T9001", bookingCode: "GET-90000001", ext: "GYGORDER1", status: "CONFIRMED", day: search.date }]);
    expect(ok.restore.map((r) => r.id)).toEqual([search.id]);
    const mixed = plan([search], [
      { productCode: "FOLK-T9001", bookingCode: "GET-90000001", ext: "GYGORDER1", status: "CONFIRMED", day: search.date },
      { productCode: "FOLK-T9002", bookingCode: "GET-90000001", ext: "GYGORDER1", status: "CANCELLED", day: search.date },
    ]);
    expect(mixed.restore).toEqual([]);
  });

  it("both copies archived: the product copy comes back, the search copy stays hidden", () => {
    const product = row({ externalRef: "GYGORDER2" });
    const search = row({ confirmationCode: "GET-90000002", externalRef: "GYGORDER2" });
    const p = plan([product, search], [bk(product, { bookingCode: "GET-90000002" })]);
    expect(p.restore.map((r) => r.id)).toEqual([product.id]);
    expect(p.exceptions.map((e) => e.reason)).toEqual(["a second copy of a booking that is already on the board or coming back"]);
  });

  it("a copy already live keeps its place: the archived one stays hidden", () => {
    const live = row({ status: "PENDING", confirmationCode: "GET-90000003", externalRef: "GYGORDER3" });
    const product = row({ externalRef: "GYGORDER3" });
    const p = plan([live, product], [bk(product, { bookingCode: "GET-90000003" })]);
    expect(p.restore).toEqual([]);
    const sameCode = row({ status: "OFFERED" });
    const archived = row({ confirmationCode: sameCode.confirmationCode });
    expect(plan([sameCode, archived], [bk(archived)]).restore).toEqual([]);
  });

  it("an order with several product bookings brings each one back", () => {
    const a = row({ externalRef: "GYGORDER4", tourId: "T-901" });
    const b = row({ externalRef: "GYGORDER4", tourId: "T-901" });
    const p = plan([a, b], [bk(a, { bookingCode: "GET-4" }), bk(b, { bookingCode: "GET-4" })]);
    expect(p.restore.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("the same list gives the same hash, a different list another", () => {
    const rs = [row(), row()];
    const one = plan(rs, rs.map((r) => bk(r)));
    expect(plan([...rs].reverse(), rs.map((r) => bk(r))).hash).toBe(one.hash);
    expect(plan(rs, [bk(rs[0])]).hash).not.toBe(one.hash);
  });
});

describe("reading Bókun", () => {
  it("a start date in epoch milliseconds is the Bangkok calendar day", () => {
    expect(bangkokDay(Date.UTC(2099, 3, 9, 18, 0))).toBe("2099-04-10");
    expect(bangkokDay("2099-04-10T08:30:00")).toBe("2099-04-10");
    expect(bangkokDay(null)).toBeNull();
  });
  it("a search result keeps its product code, booking code, OTA number, status and day", () => {
    expect(toBokunItem({ productConfirmationCode: "FOLK-T1", confirmationCode: "GET-1", externalBookingReference: "GYG1", status: "ARRIVED", startDate: Date.UTC(2099, 3, 10) }))
      .toEqual({ productCode: "FOLK-T1", bookingCode: "GET-1", ext: "GYG1", status: "ARRIVED", day: "2099-04-10" });
  });
});
