import { prisma } from "@/lib/db";
import { makeRef } from "@/lib/jobsheet";

// The next unique job number for a date: FOLK-BKK-YYYYMMDD-NN.
// Uses the MAX existing suffix + 1 (not a row count — count mis-numbers across the
// different creation paths and after deletions, and lets two same-day sheets land
// on the same number) and skips any number already taken. So a split (two guides,
// one day) gets -02 and -03, never two -02s.
export async function nextJobRef(date: string): Promise<string> {
  const stamp = date.replace(/-/g, "");
  const rows = await prisma.jobSheet.findMany({
    where: { date, ref: { startsWith: `FOLK-BKK-${stamp}-` } },
    select: { ref: true },
  });
  const used = new Set(rows.map((r) => r.ref));
  let seq = 0;
  for (const r of rows) {
    const m = r.ref?.match(/-(\d{2,})$/);
    if (m) seq = Math.max(seq, parseInt(m[1], 10));
  }
  let ref = makeRef(date, ++seq);
  while (used.has(ref)) ref = makeRef(date, ++seq);
  return ref;
}
