// A date-time typed into an <input type="datetime-local"> comes without a time zone —
// "2026-10-04T22:42" — and means Bangkok. `new Date()` on the server (which runs in UTC)
// reads it as UTC: 22:42 becomes 05:42 the next day in Bangkok, so an evening transfer was
// checked against the wrong day ("the date on the slip is not the one typed") and refused,
// or refused as "in the future". A value with no zone is read as Bangkok time here.
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A typed date-time as an instant: no zone = Bangkok (+07:00); a date alone = noon Bangkok; anything with a zone as given. */
export function parseBangkokDateTime(raw: string | null | undefined): Date {
  const v = (raw ?? "").trim();
  if (LOCAL.test(v)) return new Date(`${v.length === 16 ? `${v}:00` : v}+07:00`);
  if (DATE_ONLY.test(v)) return new Date(`${v}T12:00:00+07:00`);
  return new Date(v);
}
