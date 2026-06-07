import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { parseCSV } from "@/lib/csv";
import { normTime, timeToSlot, type ParsedBooking } from "@/lib/bookings";
import { importParsed, type ImportResult } from "@/lib/booking-import";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// Pick the first column whose (lowercased) header contains any of the candidates.
function col(row: Record<string, string>, cands: string[]): string {
  const keys = Object.keys(row);
  for (const cand of cands) {
    const k = keys.find((h) => h.toLowerCase().includes(cand));
    if (k && row[k]?.trim()) return row[k].trim();
  }
  return "";
}

// Normalise a date cell to YYYY-MM-DD (handles ISO, "Jun 7, 2026", "2026/06/07").
function toYMD(s: string): string | undefined {
  if (!s) return undefined;
  const iso = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return undefined;
}

// POST (text/csv or text body) — import a Bokun/OTA booking export. Operator only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const text = await req.text();
  if (!text.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });
  let rows: Record<string, string>[];
  try { rows = parseCSV(text); } catch { return NextResponse.json({ error: "bad-csv" }, { status: 400 }); }
  if (rows.length === 0) return NextResponse.json({ error: "no-rows", hint: "Need a header row + at least one booking." }, { status: 400 });

  const counts = { rows: rows.length, created: 0, updated: 0, skipped: 0 };
  for (const row of rows) {
    const ref = col(row, ["confirmation", "external booking reference", "booking reference", "reference", "ref", "booking id"]);
    const product = col(row, ["product", "experience", "activity", "title", "tour"]);
    const date = toYMD(col(row, ["start date", "travel date", "tour date", "arrival", "date"]));
    const time = normTime(col(row, ["start time", "departure", "pickup time", "time"]));
    const paxStr = col(row, ["total participants", "participants", "pax", "guests", "travelers", "travellers", "people", "seats"]);
    const name = col(row, ["lead", "customer name", "passenger", "guest name", "customer", "name"]);
    const statusStr = col(row, ["status"]).toLowerCase();
    const channel = col(row, ["seller", "reseller", "channel", "agent", "vendor", "source", "marketplace"]) || "Bokun";
    const pax = paxStr ? parseInt(paxStr.replace(/\D+/g, ""), 10) || null : null;
    const cancelled = /cancel/.test(statusStr);

    if (!ref && !product && !date) { counts.skipped++; continue; } // junk row
    const p: ParsedBooking = {
      externalId: undefined, confirmationCode: ref || undefined, externalRef: ref || undefined,
      productName: product || undefined, date, startTime: time, slotIdx: timeToSlot(time),
      pax: pax ?? undefined, customerName: name || undefined,
    };
    try { const r: ImportResult = await importParsed(p, { source: channel, cancelled }); counts[r]++; }
    catch { counts.skipped++; }
  }

  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bookings.csv-import", entityType: "Booking", detail: counts });
  return NextResponse.json({ ok: true, ...counts });
}
