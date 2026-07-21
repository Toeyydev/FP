// Standalone Bokun signing smoke test — validates the HMAC scheme AND the booking
// JSON shape against a REAL key, with no dependency on the app build. It reproduces
// exactly what src/lib/bokun/client.ts does, so a green run here means the client's
// signing + pax parsing are correct for your Bokun account.
//
// Usage (keys come from the env — never hard-code them):
//   BOKUN_ACCESS_KEY=xxx BOKUN_SECRET_KEY=yyy node scripts/bokun-smoke.mjs <bokunBookingId>
//   optional: BOKUN_API_BASE=https://api.bokun.io   (default)
//
// Pick a <bokunBookingId> you can see in Bokun (the Booking.externalId in our DB).

import { createHmac } from "node:crypto";

const accessKey = process.env.BOKUN_ACCESS_KEY;
const secretKey = process.env.BOKUN_SECRET_KEY;
const base = process.env.BOKUN_API_BASE || "https://api.bokun.io";
const bookingId = process.argv[2];

if (!accessKey || !secretKey || !bookingId) {
  console.error("Usage: BOKUN_ACCESS_KEY=.. BOKUN_SECRET_KEY=.. node scripts/bokun-smoke.mjs <bokunBookingId>");
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 19).replace("T", " "); // UTC "yyyy-MM-dd HH:mm:ss"
const method = "GET";
const path = `/booking.json/${encodeURIComponent(bookingId)}`;
const signature = createHmac("sha1", secretKey).update(date + accessKey + method + path, "utf8").digest("base64");

const res = await fetch(base + path, {
  method,
  headers: {
    "X-Bokun-Date": date,
    "X-Bokun-AccessKey": accessKey,
    "X-Bokun-Signature": signature,
    Accept: "application/json",
  },
});

console.log("HTTP", res.status);
const text = await res.text();
let json;
try { json = JSON.parse(text); } catch { json = null; }

if (res.status === 401 || res.status === 403) {
  console.error("AUTH FAILED — the signing scheme or keys are wrong. Check the message layout in bokunSignature (date + accessKey + METHOD + path).");
  process.exit(2);
}
if (!json) { console.log(text.slice(0, 800)); process.exit(res.ok ? 0 : 2); }

const pax = typeof json.totalParticipants === "number"
  ? json.totalParticipants
  : (json.productBookings ?? []).reduce((s, pb) => s + (pb.priceCategoryBookings ?? []).reduce((a, c) => a + (Number(c.quantity) || 0), 0), 0);

console.log("status field :", json.status);
console.log("derived pax  :", pax);
console.log(pax > 0 ? "✓ pax parsed — client parsing is correct." : "⚠ pax came out 0 — check the real payload's participant fields and update channelPax() in client.ts.");
console.log("If HTTP is 200 and status/pax look right, lib/bokun/client.ts is validated for your account.");
