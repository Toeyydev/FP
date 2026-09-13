import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

// Only an explicitly supplied disposable test database is used, never DATABASE_URL.
const state = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("@/lib/db", () => ({ get prisma() { return state.db; } }));
import { ensureJobRef, nextJobRef } from "./jobref";
const url = process.env.JOBREF_TEST_DATABASE_URL;
const schema = `jobref_test_${randomUUID().replaceAll("-", "")}`;
let admin: PrismaClient;
describe.skipIf(!url)("job reference reservations (PostgreSQL)", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: url });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(url!);
    isolated.searchParams.set("schema", schema);
    isolated.searchParams.set("connection_limit", "10");
    state.db = new PrismaClient({ datasourceUrl: isolated.toString() });
    await state.db.$executeRawUnsafe('CREATE TABLE "JobRefCounter" ("date" TEXT PRIMARY KEY, "lastSeq" BIGINT NOT NULL)');
    await state.db.$executeRawUnsafe('CREATE TABLE "JobSheet" ("id" TEXT PRIMARY KEY, "date" TEXT NOT NULL, "ref" TEXT, "updatedAt" TIMESTAMP DEFAULT now())');
  });
  afterAll(async () => {
    await state.db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });
  it("reserves distinct numbers under concurrency, including wrong-date legacy refs", async () => {
    await state.db!.$executeRaw`INSERT INTO "JobSheet" ("id", "date", "ref") VALUES ('legacy', '2030-01-01', 'FOLK-BKK-20300513-10')`;
    const refs = await Promise.all(Array.from({ length: 30 }, () => nextJobRef("2030-05-13")));
    expect(new Set(refs).size).toBe(30);
    expect(refs.sort()).toEqual(Array.from({ length: 30 }, (_, i) => `FOLK-BKK-20300513-${i + 11}`));
    expect(await nextJobRef("2030-05-14")).toBe("FOLK-BKK-20300514-01");
  });
  it("never hands out a number an older instance already wrote the old way", async () => {
    expect(await nextJobRef("2030-05-16")).toBe("FOLK-BKK-20300516-01");
    // During a rolling deploy the previous version numbers a sheet as highest suffix + 1.
    await state.db!.$executeRaw`INSERT INTO "JobSheet" ("id", "date", "ref") VALUES ('old-way', '2030-05-16', 'FOLK-BKK-20300516-02')`;
    expect(await nextJobRef("2030-05-16")).toBe("FOLK-BKK-20300516-03");
  });
  it("concurrent opens attach one stable reference and preserve existing refs", async () => {
    await state.db!.$executeRaw`INSERT INTO "JobSheet" ("id", "date", "ref") VALUES ('new', '2030-05-15', NULL)`;
    const refs = await Promise.all(Array.from({ length: 20 }, () => ensureJobRef("new", "2030-05-15")));
    expect(new Set(refs).size).toBe(1);
    expect(await ensureJobRef("new", "2030-05-15")).toBe(refs[0]);
    expect(await ensureJobRef("legacy", "2030-01-01")).toBe("FOLK-BKK-20300513-10");
  });
});
