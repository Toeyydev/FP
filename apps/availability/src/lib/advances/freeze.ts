// The cutover switch.
//
// Between the moment the ledger migration runs and the moment the ledger app is live,
// the advance tables must take no new writes from anywhere: the old app cannot fill the
// ledger's columns (it does not know about them), and a return it writes to the legacy
// table would never reach the ledger. Hiding the buttons is not enough — a retry, an open
// tab, or the mobile app would still post.
//
// Set ADVANCE_WRITES_FROZEN=1 on the service and every write path below refuses with 503
// and an explanation. Reads stay open, so nobody is blind while it is on.
export const advanceWritesFrozen = () => (process.env.ADVANCE_WRITES_FROZEN ?? "").trim() === "1";

export const ADVANCE_FROZEN_MESSAGE =
  "Advances and returns are being moved to the new ledger. Recording is paused for a few minutes — nothing is lost, please try again shortly.";

/** The body every frozen write path answers with. */
export const advanceFrozenBody = { error: "advance-writes-frozen", reasons: [ADVANCE_FROZEN_MESSAGE], detail: ADVANCE_FROZEN_MESSAGE };

// Reconciliation mode — a second, narrower switch.
//
// The freeze above stops every advance write. But the reason the freeze is still on
// is that the old records have to be matched against the documents PEAK already
// carries, and matching them is itself a write: a return is confirmed, a settlement
// is recorded, a document number is kept. So there is one opening in the wall, and
// it is opened deliberately:
//
//   ADVANCE_WRITES_FROZEN=1              ordinary advance writes stay refused
//   ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1  an admin may record an EXISTING document
//   PEAK_ADVANCE_AUTO_SYNC=0             the sender stays off
//
// Unset means off, like every other switch here. Nothing else changes: recording a
// new advance, uploading a return, the ordinary confirm / allocate / settle buttons
// and reversals are all still refused while the freeze is on.
export const existingPeakLinksEnabled = () => (process.env.ADVANCE_EXISTING_PEAK_LINKS_ENABLED ?? "").trim() === "1";

/** True when the deployment is set up for reconciliation and nothing else. */
export const advanceReconciliationMode = () => existingPeakLinksEnabled() && advanceWritesFrozen();

/** The sender's own switch, read in one place so both sides agree what "on" means. */
export const advanceAutoSyncEnabled = () => (process.env.PEAK_ADVANCE_AUTO_SYNC ?? "").trim() === "1";

export const EXISTING_LINKS_OFF_MESSAGE =
  "Recording an existing PEAK document is switched off. Set ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1 to reconcile the records that PEAK already carries.";
export const AUTO_SYNC_ON_MESSAGE =
  "The automatic sender is on. Turn PEAK_ADVANCE_AUTO_SYNC off before reconciling, so the two cannot reach the same movement at once.";
