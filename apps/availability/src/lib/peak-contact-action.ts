// What the PEAK Contact box's Save button is allowed to do.
//
// The API treats an empty peakContactId as "clear this mapping" — a deliberate
// escape hatch for a wrong pick. The box, however, sits OPEN whenever the guide
// is unmapped, with nothing selected, so pressing Save sent an empty id and was
// recorded as a clear. Production shows 17 such clears and zero successful
// mappings: every one is a `from=null → to=null` no-op fired in bursts, the
// signature of an operator pressing Save on a list that had not loaded.
//
// Harmless only because nothing was ever mapped. The moment a mapping exists,
// that same press wipes it — so a blank Save must not reach the API at all, and
// unlinking has to be its own act.
export type ContactSaveDecision =
  | { action: "save"; contactId: string }
  | { action: "blocked"; reason: "empty" | "unchanged" };

export function contactSaveDecision(
  selected: string | null | undefined,
  currentId: string | null | undefined,
): ContactSaveDecision {
  const next = (selected ?? "").trim();
  if (!next) return { action: "blocked", reason: "empty" };
  // Re-saving the same contact writes nothing but an audit row; the operator
  // gains no information from it and the trail reads as a change that never was.
  if (next === (currentId ?? "").trim()) return { action: "blocked", reason: "unchanged" };
  return { action: "save", contactId: next };
}

// Why Save is unavailable, for the button's tooltip. Never shown as an error:
// nothing has gone wrong, there is simply nothing to write.
export function contactSaveHint(d: ContactSaveDecision): string | undefined {
  if (d.action === "save") return undefined;
  return d.reason === "empty"
    ? "Pick the guide's contact in PEAK first."
    : "This guide is already mapped to that contact.";
}

// Is the PEAK Contact control on screen? Render and the effect that loads PEAK's
// contact list MUST agree on this, and they did not: the box was shown when the
// operator opened it OR the guide was unmapped, while the fetch ran only when the
// operator had opened it. Every guide is unmapped, so the box sat open on
// "Loading PEAK contacts…" having never sent the request — forever, on every job
// sheet. That, not the stale client token, is why zero guides were ever mapped:
// there was no list to pick from, and the only pressable button was Save.
//
// One predicate, used by both, so the two cannot drift apart again.
export function contactBoxOpen(contactEdit: string | null, contactMapped: boolean): boolean {
  return contactEdit !== null || !contactMapped;
}
