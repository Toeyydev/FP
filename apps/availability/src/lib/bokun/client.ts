// Bokun REST client — SERVER ONLY (uses node:crypto + process.env; never import
// from a client component). Reads a booking's live state from Bokun, which is how
// we see the authoritative GetYourGuide status for "Option A" (detect & alert).
//
// Auth is Bokun's HMAC scheme: every request carries X-Bokun-Date,
// X-Bokun-AccessKey and X-Bokun-Signature, where the signature is
//   base64( HMAC-SHA1( secretKey, date + accessKey + METHOD + path ) )
// and the date is UTC "yyyy-MM-dd HH:mm:ss".
//
// ⚠️ SMOKE TEST BEFORE RELYING ON THIS: the signing algorithm and the booking
// JSON shape (status field + participant count) are implemented to Bokun's
// documented contract but have NOT been exercised against a live key here. Do one
// real call (see scripts note in the PR) and confirm a 200 + correct pax before
// wiring alerts to it. The signing is isolated in `bokunSignature` so a fix is a
// one-line change if the contract differs.

import { createHmac } from "crypto";
import { normalizeChannelStatus, type ChannelBookingState } from "@/lib/reconcile";

export type BokunConfig = {
  accessKey: string;
  secretKey: string;
  baseUrl: string;
  /** Injectable clock for tests; defaults to real UTC now. */
  now?: () => Date;
};

// UTC timestamp in Bokun's required "yyyy-MM-dd HH:mm:ss" format.
export function bokunDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// The X-Bokun-Signature value. Pure + deterministic → unit-tested.
export function bokunSignature(p: { date: string; accessKey: string; secretKey: string; method: string; path: string }): string {
  const message = p.date + p.accessKey + p.method.toUpperCase() + p.path;
  return createHmac("sha1", p.secretKey).update(message, "utf8").digest("base64");
}

export function bokunConfigFromEnv(): BokunConfig | null {
  const accessKey = process.env.BOKUN_ACCESS_KEY;
  const secretKey = process.env.BOKUN_SECRET_KEY;
  if (!accessKey || !secretKey) return null; // integration simply disabled if unset
  return { accessKey, secretKey, baseUrl: process.env.BOKUN_API_BASE || "https://api.bokun.io" };
}

type BokunResponse = { status: number; json: unknown };

async function bokunGet(cfg: BokunConfig, path: string): Promise<BokunResponse> {
  const date = bokunDate(cfg.now ? cfg.now() : new Date());
  const signature = bokunSignature({ date, accessKey: cfg.accessKey, secretKey: cfg.secretKey, method: "GET", path });
  const res = await fetch(cfg.baseUrl + path, {
    method: "GET",
    headers: {
      "X-Bokun-Date": date,
      "X-Bokun-AccessKey": cfg.accessKey,
      "X-Bokun-Signature": signature,
      Accept: "application/json",
    },
  });
  const json = res.status === 404 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

// Best-effort participant count from a Bokun booking payload. Bokun exposes this
// differently across shapes, so try the common fields defensively; SMOKE TEST this
// against a real payload and pin the right field.
export function channelPax(json: Record<string, unknown>): number {
  if (typeof json.totalParticipants === "number") return json.totalParticipants;
  const productBookings = (json.productBookings as Array<Record<string, unknown>>) ?? [];
  let sum = 0;
  for (const pb of productBookings) {
    const cats = (pb.priceCategoryBookings as Array<Record<string, unknown>>) ?? [];
    for (const c of cats) sum += Number(c.quantity) || 0;
  }
  return sum;
}

// Read one booking's authoritative state from Bokun (i.e. what GetYourGuide shows).
// Returns { found: false } for a 404 so the reconciler can treat it as purged upstream.
export async function getBookingState(cfg: BokunConfig, bokunBookingId: string): Promise<ChannelBookingState> {
  const { status, json } = await bokunGet(cfg, `/booking.json/${encodeURIComponent(bokunBookingId)}`);
  if (status === 404 || json == null) return { found: false };
  if (status >= 400) throw new Error(`Bokun getBooking ${bokunBookingId}: HTTP ${status}`);
  const j = json as Record<string, unknown>;
  return {
    found: true,
    status: normalizeChannelStatus(String(j.status ?? "CONFIRMED")),
    pax: channelPax(j),
  };
}
