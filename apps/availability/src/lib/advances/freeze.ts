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
