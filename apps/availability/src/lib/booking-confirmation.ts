// The guest's confirmation: subject, plain text, HTML and a calendar invite.
//
// Pure — it formats, it does not send. The route sends, so a broken template can
// be caught by a test rather than by a guest receiving nothing.
//
// Two rules the templates keep:
//   * The voucher code appears in the subject line. Guests search their inbox for
//     it at the pier, and a subject that only says "Your booking is confirmed"
//     is indistinguishable from every other confirmation they have.
//   * The plain-text part is complete on its own. A good share of travellers read
//     mail as text, and an HTML-only confirmation is a blank message to them.

export type ConfirmationInput = {
  voucherCode: string;
  tourName: string;
  date: string;            // YYYY-MM-DD
  time: string;            // HH:MM
  pax: number;
  adults?: number | null;
  children?: number | null;
  customerName: string;
  meetingPoint?: string | null;
  total?: number | null;
  currency?: string | null;
  durationMin?: number | null;
  paymentNote?: string | null;
};

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function longDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return date;
  return `${DAYS[d.getDay()]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function money(v: number | null | undefined, currency = "THB"): string {
  if (v == null || !Number.isFinite(v)) return "";
  const sym = currency === "THB" ? "฿" : "";
  return `${sym}${v.toLocaleString("en-US")}${sym ? "" : ` ${currency}`}`;
}

function partyLine(i: ConfirmationInput): string {
  const a = i.adults ?? null, c = i.children ?? null;
  if (a == null && c == null) return `${i.pax} guest${i.pax === 1 ? "" : "s"}`;
  const bits: string[] = [];
  if (a) bits.push(`${a} adult${a === 1 ? "" : "s"}`);
  if (c) bits.push(`${c} child${c === 1 ? "" : "ren"}`);
  return bits.join(", ") || `${i.pax} guest${i.pax === 1 ? "" : "s"}`;
}

export const DEFAULT_PAYMENT_NOTE =
  "Nothing to pay yet. We'll send a PromptPay QR, or you can pay us on the day.";

/** Short date for the subject line only — the body uses the long form. */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return date;
  return `${DAYS[d.getDay()].slice(0, 3)} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1].slice(0, 3)}`;
}

export function confirmationSubject(i: ConfirmationInput): string {
  // The code goes FIRST. Inbox lists truncate at roughly 60-70 characters, and a
  // tour name of its own is longer than that — putting the code at the end meant
  // the one thing a guest scans for was the first thing cut off. Search still
  // matched it, but only if they thought to search.
  return `${i.voucherCode} · ${i.tourName} · ${shortDate(i.date)} ${i.time}`;
}

export function confirmationText(i: ConfirmationInput): string {
  const lines = [
    `Hi ${i.customerName.split(" ")[0] || i.customerName},`,
    "",
    "Your booking with Folkpaths is confirmed.",
    "",
    `BOOKING CODE: ${i.voucherCode}`,
    "",
    i.tourName,
    `${longDate(i.date)} at ${i.time}`,
    partyLine(i),
  ];
  if (i.meetingPoint) lines.push(`Meet at: ${i.meetingPoint}`);
  if (i.total != null) lines.push(`Total: ${money(i.total, i.currency ?? "THB")}`);
  lines.push(
    "",
    i.paymentNote ?? DEFAULT_PAYMENT_NOTE,
    "",
    "Please arrive 15 minutes before the start time, and bring this code —",
    "your guide will ask for it at the meeting point.",
    "",
    "Need to change something? Just reply to this email.",
    "",
    "Folkpaths Travel, Bangkok",
  );
  return lines.join("\n");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function confirmationHtml(i: ConfirmationInput): string {
  // Table layout and inline styles on purpose: Gmail, Outlook and Thai webmail
  // clients strip <style> blocks and do not support flexbox or grid.
  const row = (label: string, value: string) =>
    `<tr><td style="padding:5px 14px 5px 0;color:#54655D;font-size:14px;white-space:nowrap">${esc(label)}</td>` +
    `<td style="padding:5px 0;color:#0B2A21;font-size:14px;font-weight:600">${esc(value)}</td></tr>`;

  const rows = [
    row("Tour", i.tourName),
    row("When", `${longDate(i.date)} at ${i.time}`),
    row("Guests", partyLine(i)),
    i.meetingPoint ? row("Meet at", i.meetingPoint) : "",
    i.total != null ? row("Total", money(i.total, i.currency ?? "THB")) : "",
  ].join("");

  return `<!doctype html><html><body style="margin:0;padding:0;background:#EEF0EA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF0EA;padding:26px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #D8DDD3;border-radius:14px;overflow:hidden;font-family:Helvetica,Arial,sans-serif">
  <tr><td style="background:#0B2A21;padding:20px 24px">
    <div style="color:#C9A55E;font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:700">Booking confirmed</div>
    <div style="color:#F3F5EF;font-size:19px;font-weight:700;margin-top:6px">Folkpaths</div>
  </td></tr>
  <tr><td style="padding:24px">
    <p style="margin:0 0 18px;color:#0B2A21;font-size:15px">Hi ${esc(i.customerName.split(" ")[0] || i.customerName)}, your booking is confirmed.</p>
    <div style="border:1px dashed #CBE5D6;background:#EAF4EF;border-radius:12px;padding:16px;text-align:center;margin-bottom:20px">
      <div style="color:#0E7A43;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700">Your booking code</div>
      <div style="color:#0E7A43;font-size:29px;font-weight:700;letter-spacing:.05em;margin-top:5px;font-family:'Courier New',monospace">${esc(i.voucherCode)}</div>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${rows}</table>
    <div style="border:1px solid #E2D1AC;background:#F3EAD6;border-radius:11px;padding:13px 15px;margin-top:20px;color:#0B2A21;font-size:14px;line-height:1.55">
      ${esc(i.paymentNote ?? DEFAULT_PAYMENT_NOTE)}
    </div>
    <p style="margin:18px 0 0;color:#54665D;font-size:13.5px;line-height:1.6">
      Please arrive 15 minutes early and bring your code — your guide will ask for it at the meeting point.
      Need to change something? Just reply to this email.
    </p>
  </td></tr>
  <tr><td style="background:#F7F7F5;border-top:1px solid #D8DDD3;padding:14px 24px;color:#8B9A92;font-size:12px">
    Folkpaths Travel, Bangkok
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Calendar invite ─────────────────────────────────────────────────────────

/** Thailand is UTC+7 year-round with no daylight saving, so local wall-clock
 *  times convert to UTC by subtracting seven hours exactly. Emitting UTC with a
 *  Z suffix avoids shipping a VTIMEZONE block that older clients mis-parse. */
const BANGKOK_OFFSET_MIN = 7 * 60;

export function icsTimestamp(date: string, time: string, addMinutes = 0): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const utc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const at = new Date(utc - BANGKOK_OFFSET_MIN * 60_000 + addMinutes * 60_000);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// RFC 5545: backslash, semicolon and comma are escaped; newlines become \n.
const icsEsc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Returns null when the date/time cannot be parsed — a missing invite is fine,
 *  a malformed one makes the whole email look broken in Outlook. */
export function bookingIcs(i: ConfirmationInput, now = new Date()): string | null {
  const start = icsTimestamp(i.date, i.time);
  const end = icsTimestamp(i.date, i.time, i.durationMin ?? 360);
  if (!start || !end) return null;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const desc = `Booking code ${i.voucherCode}. ${partyLine(i)}.`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Folkpaths//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEsc(i.voucherCode)}@folkpaths.com`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEsc(i.tourName)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    ...(i.meetingPoint ? [`LOCATION:${icsEsc(i.meetingPoint)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function buildConfirmation(i: ConfirmationInput) {
  return {
    subject: confirmationSubject(i),
    text: confirmationText(i),
    html: confirmationHtml(i),
    ics: bookingIcs(i),
  };
}
