// Reconciliation core for "Option A" (detect & alert): compares a portal booking
// against the channel (GetYourGuide, read via Bokun) and classifies any drift.
//
// This is deliberately PURE and deterministic — no DB, no network — so the actual
// decision logic is fully unit-testable on its own. The network layer (signing +
// fetching a booking's live state from Bokun) lives separately in lib/bokun/client
// and only has to hand this function a normalized ChannelBookingState.
//
// Direction of truth: GetYourGuide is authoritative for OTA bookings. The portal
// never writes back to the channel; it only reads the channel and flags mismatches.

export type BookingLifecycle = "Active" | "Cancelled";

// Portal Booking.status is PENDING | OFFERED | ASSIGNED | CANCELLED | IGNORED.
// Everything that isn't cancelled/ignored is a live booking the guest is expected on.
export function normalizePortalStatus(status: string): BookingLifecycle {
  const s = status.trim().toUpperCase();
  return s === "CANCELLED" || s === "IGNORED" ? "Cancelled" : "Active";
}

// Bokun/GYG booking status is typically CONFIRMED | CANCELLED (plus channel-specific
// variants). Treat an explicit cancelled/declined/expired as Cancelled, else Active.
export function normalizeChannelStatus(status: string): BookingLifecycle {
  const s = status.trim().toUpperCase();
  return s === "CANCELLED" || s === "DECLINED" || s === "EXPIRED" || s === "REJECTED" ? "Cancelled" : "Active";
}

export type PortalBookingState = {
  bookingId: string;          // portal Booking.id
  externalId: string | null;  // Bokun booking id (the join key to the channel)
  ref: string | null;         // display ref (OTA ref / FOLK-BKK-…)
  status: BookingLifecycle;
  pax: number;
};

export type ChannelBookingState =
  // The booking's live state as read from the channel…
  | { found: true; status: BookingLifecycle; pax: number }
  // …or the channel has no such booking (cancelled+purged upstream, or bad id).
  | { found: false };

export type ReconKind =
  | "OK"
  | "STATUS_MISMATCH"
  | "PAX_MISMATCH"
  | "MISSING_ON_CHANNEL";

export type ReconResult = {
  kind: ReconKind;
  /** Human-readable next action for the operator alert. */
  action: string;
  /** Convenience: false only when kind === "OK". */
  drift: boolean;
};

const OK: ReconResult = { kind: "OK", action: "—", drift: false };

// Classify one portal booking against its channel state. Mirrors the table in
// Folkpaths_OptionA_Design.md so the automated check matches the manual tracker.
export function reconcile(portal: PortalBookingState, channel: ChannelBookingState): ReconResult {
  if (!channel.found) {
    // Portal still thinks this booking is live, but the channel has no record of it.
    if (portal.status === "Active") {
      return { kind: "MISSING_ON_CHANNEL", action: "Active on the portal but not found on GetYourGuide — verify it wasn't cancelled/rebooked upstream, then update the portal.", drift: true };
    }
    // Portal already cancelled and the channel has no record → nothing to do.
    return OK;
  }

  if (portal.status !== channel.status) {
    if (portal.status === "Cancelled" && channel.status === "Active") {
      return { kind: "STATUS_MISMATCH", action: "Cancelled on the portal but still ACTIVE on GetYourGuide — cancel it on GYG now (or reverse the portal cancellation if it wasn't real).", drift: true };
    }
    return { kind: "STATUS_MISMATCH", action: "Cancelled on GetYourGuide but still active on the portal — update the portal to match.", drift: true };
  }

  // Same lifecycle. Pax only matters while the booking is live.
  if (portal.status === "Active" && portal.pax !== channel.pax) {
    return { kind: "PAX_MISMATCH", action: `Pax differ (portal ${portal.pax} vs GetYourGuide ${channel.pax}) — align the portal to GYG.`, drift: true };
  }

  return OK;
}
