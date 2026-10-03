// May a new accounting entry be written right now?
//
// Two reasons it may not, checked in this order:
//   1. the cutover freeze (ADVANCE_WRITES_FROZEN=1) — every advance write is refused;
//   2. unsafe PEAK switches (lib/peak-switches) — the sender and the linker could both
//      reach the movement this write would create, so nothing new is created until the
//      switches are put right.
// Reads and metadata that never reach PEAK (an advance's categories, rejecting or voiding
// an unconfirmed return claim) are not gated here.
import type { PrismaClient } from "@prisma/client";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { readPeakSafety, unsafeWriteBody } from "@/lib/peak-switches";

export type WriteRefusal = { status: number; body: Record<string, unknown> };

export async function accountingWriteRefusal(db: Pick<PrismaClient, "serviceStatus">): Promise<WriteRefusal | null> {
  if (advanceWritesFrozen()) return { status: 503, body: advanceFrozenBody };
  const safety = await readPeakSafety(db);
  if (!safety.accountingWritesAllowed) return { status: 503, body: unsafeWriteBody(safety) };
  return null;
}
