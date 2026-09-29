import { prisma } from "@/lib/db";
import { googleDriveEnabled, folkpathsDriveToken, saveHtmlToDrive } from "@/lib/google-drive";
import { saveAdvanceVoucher } from "./voucher";

// The one place that wires the voucher to the real Drive.
//
// Kept apart from voucher.ts so that file stays free of Drive and Prisma singletons
// and can be tested with nothing but its input — the same reason the slip uploader
// lives in its own module.
export function issueVoucherFor(advanceId: string): Promise<string | null> {
  return saveAdvanceVoucher(prisma, advanceId, {
    enabled: googleDriveEnabled,
    token: () => folkpathsDriveToken(),
    saveHtml: saveHtmlToDrive,
  });
}
