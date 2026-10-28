import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// A guide is busy only in the slots they blocked (owner, 2026-10-28): one who blocked the
// morning is offered the afternoon. It used to be the whole day, so a guide the app had
// told "your other times are free" vanished from every picker that day. Real database;
// all data invented.
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { availableGuides } from "@/lib/offers";
import { SLOT_TIMES } from "@/lib/slots";

const DATE = "2099-06-10";
const at = (t: string) => SLOT_TIMES.indexOf(t);
const MINE = new Set(["G-971", "G-972"]);
const ids = async (t: string) => (await availableGuides(DATE, at(t))).map((g) => g.guideId).filter((g): g is string => !!g && MINE.has(g)).sort();
const block = (guideId: string, times: string[]) =>
  prisma.availability.create({ data: { guideId, date: DATE, slots: SLOT_TIMES.map((t) => times.includes(t)) } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide("G-971", { displayName: "Morning Off Example" });
  await seedGuide("G-972", { displayName: "Free Example" });
});

describe("availableGuides — busy only in the slots a guide blocked", () => {
  it("a guide who blocked the morning is free for the afternoon", async () => {
    await block("G-971", ["08:30", "10:00"]);
    expect(await ids("13:30")).toEqual(["G-971", "G-972"]);
    expect(await ids("08:30")).toEqual(["G-972"]);
  });
  it("a blocked slot also keeps them off a departure that overlaps it in time", async () => {
    await block("G-971", ["13:30"]);
    expect(await ids("14:00")).toEqual(["G-972"]); // 13:30 and 14:00 clash
    expect(await ids("16:30")).toEqual(["G-971", "G-972"]);
  });
  it("a guide on approved leave is still off all day", async () => {
    await prisma.leaveRequest.create({ data: { guideId: "G-971", fromDate: DATE, toDate: DATE, status: "APPROVED" } as never });
    expect(await ids("13:30")).toEqual(["G-972"]);
  });
});
