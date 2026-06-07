import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { parseCSV } from "@/lib/csv";
import { normTime, timeToSlot, type ParsedBooking } from "@/lib/bookings";
import { importParsed, type ImportResult } from "@/lib/booking-import";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

function col(row: Record<string, string>, cands: string[]): string {
  const keys = Object.keys(row);
  for (const cand of cands) {
    const k = keys.find((h) => h.toLowerCase().includes(cand));
    if (k && row[k]?.trim()) return row[k].trim();
  }
  return "";
}
function toYMD(s: string): string | undefined {
  if (!s) return undefined;
  const iso = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
function cellToStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    return "";
  }
  return String(v);
}

// Parse an .xlsx buffer → array of {header: value} rows (first row = headers).
async function parseXlsx(buf: ArrayBuffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    const vals = row.values as unknown[]; // 1-indexed
    if (n === 1) { for (let i = 1; i < vals.length; i++) headers[i - 1] = cellToStr(vals[i]).trim(); return; }
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = cellToStr(vals[i + 1]).trim(); });
    if (Object.values(o).some((v) => v)) rows.push(o);
  });
  return rows;
}

// POST multipart (file) OR raw text — import a Bokun/OTA booking export
// (.csv or .xlsx). Operator only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let rows: Record<string, string>[] = [];
  const ctype = req.headers.get("content-type") || "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      // Duck-type instead of `instanceof File` (the File global isn't guaranteed
      // in the Node server runtime — that was throwing "File is not defined").
      const file = form.get("file") as unknown as { name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
      if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "no-file", hint: "No file received — pick a .csv or .xlsx and try again." }, { status: 400 });
      const name = (file.name || "").toLowerCase();
      const buf = await file.arrayBuffer();
      const isXlsx = name.endsWith(".xlsx") || name.endsWith(".xls") || new Uint8Array(buf)[0] === 0x50; // "PK" zip header
      rows = isXlsx ? await parseXlsx(buf) : parseCSV(new TextDecoder().decode(buf));
    } else {
      rows = parseCSV(await req.text());
    }
  } catch (e) {
    return NextResponse.json({ error: "parse-failed", detail: (e as Error).message.slice(0, 200) }, { status: 400 });
  }
  if (rows.length === 0) return NextResponse.json({ error: "no-rows", hint: "Couldn't read any rows — make sure the first row has column headers." }, { status: 400 });

  const counts = { rows: rows.length, created: 0, updated: 0, skipped: 0 };
  for (const row of rows) {
    const ref = col(row, ["confirmation", "external booking reference", "booking reference", "reference", "ref", "booking id"]);
    const product = col(row, ["product", "experience", "activity", "title", "tour"]);
    const date = toYMD(col(row, ["start date", "travel date", "tour date", "arrival", "date"]));
    const time = normTime(col(row, ["start time", "departure", "pickup time", "time"]));
    const paxStr = col(row, ["total participants", "participants", "pax", "guests", "travelers", "travellers", "people", "seats"]);
    const name = col(row, ["lead", "customer name", "passenger", "guest name", "customer", "name"]);
    const cancelled = /cancel/.test(col(row, ["status"]).toLowerCase());
    const channel = col(row, ["seller", "reseller", "channel", "agent", "vendor", "source", "marketplace"]) || "Bokun";
    const pax = paxStr ? parseInt(paxStr.replace(/\D+/g, ""), 10) || null : null;

    if (!ref && !product && !date) { counts.skipped++; continue; }
    const p: ParsedBooking = {
      confirmationCode: ref || undefined, externalRef: ref || undefined, productName: product || undefined,
      date, startTime: time, slotIdx: timeToSlot(time), pax: pax ?? undefined, customerName: name || undefined,
    };
    try { const r: ImportResult = await importParsed(p, { source: channel, cancelled }); counts[r]++; }
    catch { counts.skipped++; }
  }

  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bookings.import", entityType: "Booking", detail: counts });
  return NextResponse.json({ ok: true, ...counts });
}
