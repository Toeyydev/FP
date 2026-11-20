import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

// Upsell document numbers: FOLK-UPS-YYYYMM-NNN (a sale — also the guest's receipt reference)
// and FOLK-CSH-YYYYMM-NNN (a cash settlement). Reserved atomically across processes the way
// JobRefCounter reserves job numbers (lib/jobref); a reserved number is never reused, so a
// failed save leaves a gap rather than a duplicate. The month is Bangkok's.

export const UPSELL_DOC_PREFIXES = ["FOLK-UPS", "FOLK-CSH"] as const;
export type UpsellDocPrefix = (typeof UPSELL_DOC_PREFIXES)[number];

type Db = PrismaClient | Prisma.TransactionClient;

/** "202611" — the Bangkok calendar month of an instant. */
export function bangkokMonth(at: Date): string {
  const bkk = new Date(at.getTime() + 7 * 3600 * 1000);
  return `${bkk.getUTCFullYear()}${String(bkk.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** FOLK-UPS-202611-007 */
export function formatUpsellDocNo(prefix: UpsellDocPrefix, month: string, seq: number): string {
  if (!/^\d{6}$/.test(month)) throw new RangeError(`Not a YYYYMM month: ${month}`);
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new RangeError(`Not a sequence number: ${seq}`);
  return `${prefix}-${month}-${String(seq).padStart(3, "0")}`;
}

/** Reserve the next number. Pass a transaction client to reserve inside a transaction. */
export async function nextUpsellDocNo(prefix: UpsellDocPrefix, at: Date = new Date(), db: Db = defaultPrisma): Promise<string> {
  if (!UPSELL_DOC_PREFIXES.includes(prefix)) throw new RangeError(`Unknown prefix: ${prefix}`);
  const month = bangkokMonth(at);
  const key = `${prefix}-${month}`;
  const [row] = await db.$queryRaw<{ lastSeq: number }[]>`
    INSERT INTO "UpsellDocCounter" ("key", "lastSeq") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "lastSeq" = "UpsellDocCounter"."lastSeq" + 1
    RETURNING "lastSeq"
  `;
  return formatUpsellDocNo(prefix, month, Number(row.lastSeq));
}
