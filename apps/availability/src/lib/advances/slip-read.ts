// What a transfer slip says, read from the PDF's own text — nothing more.
//
// K BIZ (KBank) hands out its slips as PDFs that carry their text: the transaction ID,
// the date, the amounts, and both parties as the bank printed them. This reads that text
// IN THIS PROCESS (unpdf, a build of Mozilla's pdf.js) — no OCR, no network, no outside
// service ever sees a name or an account. A photo of a slip, or a PDF from a layout this
// does not know, is not guessed at: it comes back unreadable, and a person checks it.
//
// The layout is read by POSITION, not by line order: the "To" column is whatever sits
// under the "ไปยัง / To" label, so the sender's name can never be taken for the
// recipient's. Parsing is pure (`parseKBizItems`) so it is tested without a PDF.

export type SlipItem = { str: string; x: number; y: number };

export type SlipRead = {
  format: "KBIZ_PDF";
  transactionId: string | null;
  /** YYYY-MM-DD (Bangkok), from the Transaction Date. */
  transferDate: string | null;
  /** Baht: Total minus Fee — what reached the recipient. */
  amount: number | null;
  recipient: {
    /** The recipient's name lines as printed, title included (one per script). */
    names: string[];
    /** The destination account as printed, e.g. "xxx-x-x1234-x". */
    accountMask: string | null;
  };
};

export type SlipReadResult = { ok: true; read: SlipRead } | { ok: false; why: string };

const NEAR = 3; // points: items on one printed line differ in y by less than this

/** Items grouped into printed lines, top to bottom, each left to right. */
function lines(items: SlipItem[]): { y: number; text: string; items: SlipItem[] }[] {
  const sorted = [...items].filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: { y: number; items: SlipItem[] }[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) < NEAR) last.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  return out.map((l) => { const its = l.items.sort((a, b) => a.x - b.x); return { y: l.y, items: its, text: its.map((i) => i.str.trim()).join(" ") }; });
}

const money = (s: string | undefined | null): number | null => {
  const m = (s ?? "").match(/(\d{1,3}(?:,\d{3})*|\d+)\.\d{2}/);
  return m ? Number(m[0].replace(/,/g, "")) : null;
};

const DATE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/;
const isoDate = (s: string): string | null => {
  const m = s.match(DATE);
  if (!m) return null;
  const [dd, mm, yyyy] = [+m[1], +m[2], +m[3]];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // A Buddhist-era year would be 543 ahead; K BIZ prints the Common Era.
  const year = yyyy > 2400 ? yyyy - 543 : yyyy;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
};

/** A masked account as banks print it: digits and x/X/*, with dashes, mostly hidden. */
const ACCOUNT_MASK = /^[xX*\d][xX*\d\- ]{5,}[xX*\d]$/;
const looksLikeAccount = (s: string) => ACCOUNT_MASK.test(s.trim()) && /\d/.test(s) && /[xX*]/.test(s);
const looksLikeBank = (s: string) => /ธนาคาร|bank\b|kasikorn|krungthai|krung thai|siam commercial|bangkok bank|ttb|tmb|thanachart|krungsri|gsb|ออมสิน/i.test(s);

/** Read a K BIZ slip from its text items. Null fields are what the slip did not show. */
export function parseKBizItems(items: SlipItem[]): SlipReadResult {
  const ls = lines(items);
  const all = ls.map((l) => l.text).join("\n");
  if (!/K\s?BIZ/i.test(all) || !/Transaction ID/i.test(all)) return { ok: false, why: "not a K BIZ slip with a text layer" };

  const idLine = ls.find((l) => /Transaction ID/i.test(l.text));
  const transactionId = idLine?.text.match(/Transaction ID\s*:?\s*([A-Z0-9]{8,})/i)?.[1]?.toUpperCase() ?? null;

  // The date printed nearest BELOW the "Transaction Date" label, in its column.
  const dateLabel = items.find((i) => /Transaction Date/i.test(i.str));
  const dateItem = dateLabel
    ? items.filter((i) => DATE.test(i.str) && i.y < dateLabel.y && Math.abs(i.x - dateLabel.x) < 60).sort((a, b) => b.y - a.y)[0]
    : undefined;
  const transferDate = dateItem ? isoDate(dateItem.str) : null;

  const total = money(ls.find((l) => /\bTotal\b/i.test(l.text))?.text);
  const fee = money(ls.find((l) => /\bFee\b/i.test(l.text))?.text) ?? 0;
  const amount = total != null ? Math.round((total - fee) * 100) / 100 : null;

  // The recipient column: everything under the "To" label, within its x band.
  const toLabel = items.find((i) => /(^|\/)\s*To\s*$/i.test(i.str.trim()) || /ไปยัง/.test(i.str));
  let names: string[] = [];
  let accountMask: string | null = null;
  if (toLabel) {
    const column = items
      .filter((i) => i.str.trim() && i.y < toLabel.y - 1 && toLabel.y - i.y < 90 && Math.abs(i.x - toLabel.x) < 15)
      .sort((a, b) => b.y - a.y);
    for (const it of column) {
      const s = it.str.trim();
      if (!accountMask && looksLikeAccount(s)) { accountMask = s; continue; }
      if (money(s) != null && !/[A-Za-z฀-๿]/.test(s)) continue;
      if (looksLikeBank(s)) break; // the bank lines close the block
      if (names.length < 2) names.push(s.replace(/\s+/g, " "));
    }
  }
  names = names.filter(Boolean);
  return { ok: true, read: { format: "KBIZ_PDF", transactionId, transferDate, amount, recipient: { names, accountMask } } };
}

/** Read a slip file. Only PDFs with a text layer are read; anything else is a person's job. */
export async function readSlip(bytes: Uint8Array, mimeType: string | null | undefined, fileName?: string | null): Promise<SlipReadResult> {
  const isPdf = /pdf/i.test(mimeType ?? "") || /\.pdf$/i.test(fileName ?? "") || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  if (!isPdf) return { ok: false, why: "an image — FolkOPS does not read pictures; check the slip by eye" };
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages < 1) return { ok: false, why: "the PDF has no pages" };
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const items: SlipItem[] = [];
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (typeof it.str === "string" && Array.isArray(it.transform)) items.push({ str: it.str, x: it.transform[4], y: it.transform[5] });
    }
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
    if (!items.some((i) => i.str.trim())) return { ok: false, why: "the PDF carries no text (a scan) — check the slip by eye" };
    return parseKBizItems(items);
  } catch {
    return { ok: false, why: "the PDF could not be read" };
  }
}
