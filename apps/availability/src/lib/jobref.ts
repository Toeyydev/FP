import { prisma } from "@/lib/db";
import { makeRef } from "@/lib/jobsheet";

// Atomically reserve a number across processes, even before the sheet is saved.
// Gaps after failed saves are intentional: a reserved number is never reused.
// Scan by prefix, not sheet date, to include incorrectly dated legacy imports.
export async function nextJobRef(date: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid job date");
  const pattern = `^FOLK-BKK-${date.replace(/-/g, "")}-[0-9]{2,}$`;
  const [row] = await prisma.$queryRaw<{ lastSeq: bigint }[]>`
    INSERT INTO "JobRefCounter" ("date", "lastSeq")
    SELECT ${date}, COALESCE(MAX(substring("ref" from '([0-9]+)$')::bigint), 0) + 1
    FROM "JobSheet" WHERE "ref" ~ ${pattern}
    ON CONFLICT ("date") DO UPDATE
    SET "lastSeq" = GREATEST("JobRefCounter"."lastSeq" + 1, EXCLUDED."lastSeq")
    RETURNING "lastSeq"
  `;
  const seq = Number(row.lastSeq);
  if (!Number.isSafeInteger(seq)) throw new Error("Job reference sequence exhausted");
  return makeRef(date, seq);
}

// The one place a sheet gets its number. Concurrent opens/imports may reserve extra numbers,
// but only the first attach wins, and a reference a sheet already has is never replaced —
// including a legacy one another sheet shares.
//
// During a rolling deploy an older instance still numbers sheets the old way (highest
// existing suffix + 1) and can write the very number this call just reserved. So right after
// attaching a NEW number, check nobody else holds it; if someone does, this sheet — whose
// number no one has been shown yet — takes a fresh reservation instead.
export async function ensureJobRef(id: string, date: string): Promise<string> {
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id }, select: { ref: true } });
  if (sheet.ref) return sheet.ref;
  let ref = await nextJobRef(date);
  const attached = await prisma.jobSheet.updateMany({ where: { id, OR: [{ ref: null }, { ref: "" }] }, data: { ref } });
  for (let i = 0; attached.count === 1 && i < 3 && (await prisma.jobSheet.count({ where: { ref, id: { not: id } } })) > 0; i++) {
    const fresh = await nextJobRef(date);
    await prisma.jobSheet.updateMany({ where: { id, ref }, data: { ref: fresh } });
    ref = fresh;
  }
  const saved = await prisma.jobSheet.findUniqueOrThrow({ where: { id }, select: { ref: true } });
  if (!saved.ref) throw new Error("Job reference was not assigned");
  return saved.ref;
}
