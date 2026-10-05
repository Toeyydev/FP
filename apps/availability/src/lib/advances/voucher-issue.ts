import { prisma } from "@/lib/db";
import { googleDriveEnabled, folkpathsDriveToken, saveHtmlToDrive } from "@/lib/google-drive";
import { audit } from "@/lib/audit";
import { saveAdvanceVoucher } from "./voucher";
import { voucherApprover } from "./voucher-approver";

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
    approver: (recordedById) => voucherApprover(recordedById),
    // Whether the filed copy carries the approver's signature is on record — never the image.
    onIssued: (o) => { void audit({ actorId: null, actorRole: "SYSTEM", action: "advance.voucher_issued", entityType: "GuideAdvance", entityId: o.advanceId, detail: { advanceNo: o.advanceNo, signed: o.signed, fileId: o.fileId } }).catch(() => {}); },
  });
}
