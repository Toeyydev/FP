import type { PrismaClient } from "@prisma/client";
import { linkExistingPeakDocument, previewLink, type DocumentLookup, type LinkRequest, type LinkResult } from "@/lib/advances/peak-link";

/** A link request as a test writes it: `acknowledgeWarnings` stands for "the person read the check and pressed Record". */
export type ScreenRequest = LinkRequest & { acknowledgeWarnings?: boolean };

/**
 * Record a link the way the screen does: check first, then record acknowledging exactly the
 * warnings that check showed. Without `acknowledgeWarnings` nothing is acknowledged.
 */
export async function linkAsScreen(prisma: PrismaClient, req: ScreenRequest, lookup?: DocumentLookup): Promise<LinkResult> {
  const { acknowledgeWarnings, ...rest } = req as ScreenRequest & Record<string, unknown>;
  const request = rest as unknown as LinkRequest;
  if (!acknowledgeWarnings) return linkExistingPeakDocument(prisma, request, lookup);
  const shown = await previewLink(prisma, request, lookup);
  return linkExistingPeakDocument(prisma, { ...request, acknowledgedWarnings: shown.ok ? shown.warnings : [] }, lookup);
}
