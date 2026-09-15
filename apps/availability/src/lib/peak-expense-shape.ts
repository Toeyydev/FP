// What a PEAK expense document is made of, line by line — to find why PEAK shows a
// column (e.g. หัก ณ ที่จ่าย) on a document made by hand in PEAK but not on one FolkOPS
// created through the API. Field names and values only; descriptions are shortened.
//
// Pure: api/peak/expense-compare fetches the documents.

type Raw = Record<string, unknown>;

const HEADER_FIELDS = ["code", "id", "status", "isVoid", "isTaxInvoice", "taxStatus", "issuedDate", "dueDate", "preTaxAmount", "vatAmount", "whtAmount", "netAmount", "paymentAmount", "remainAmount", "remainWhtAmount", "discountTotal", "reference"] as const;

const show = (v: unknown): unknown => {
  if (v == null) return v;
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Raw).map(([k, x]) => [k, show(x)]));
  return v;
};

export type ExpenseShape = {
  header: Record<string, unknown>;
  headerKeys: string[];
  lines: { n: number; fields: Record<string, unknown> }[];
  /** Payments recorded on the document — where PEAK usually records the withholding
   *  that feeds its ภ.ง.ด. report and certificate. */
  payments: { n: number; fields: Record<string, unknown> }[];
};

export function expenseShape(raw: Raw): ExpenseShape {
  const header = Object.fromEntries(HEADER_FIELDS.filter((k) => k in raw).map((k) => [k, show(raw[k])]));
  const products = Array.isArray(raw.products) ? (raw.products as Raw[]) : [];
  const paid = Array.isArray(raw.paidPayments) ? (raw.paidPayments as Raw[]) : [];
  return {
    header,
    headerKeys: Object.keys(raw).sort(),
    lines: products.map((p, i) => ({ n: i + 1, fields: Object.fromEntries(Object.keys(p).sort().map((k) => [k, show(p[k])])) })),
    payments: paid.map((p, i) => ({ n: i + 1, fields: flat(p) })),
  };
}

/** One level of nesting spelled out ("paymentMethod.id", "payments[0].amount"). */
function flat(o: Raw, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v) && !prefix) Object.assign(out, flat(v as Raw, `${k}.`));
    else if (Array.isArray(v) && !prefix && v.length && typeof v[0] === "object") v.slice(0, 3).forEach((x, i) => Object.assign(out, flat(x as Raw, `${k}[${i}].`)));
    else out[`${prefix}${k}`] = show(v);
  }
  return out;
}

const isBlank = (v: unknown) => v == null || v === "" || (typeof v === "number" && v === 0) || v === "0" || v === "0.00";

/**
 * Differences that could change how PEAK draws the document: header keys one has and
 * the other lacks, and for each line position a field set on one side and blank or
 * missing on the other, or holding a different KIND of value ("3%" against "45.00").
 * Amount differences between two unrelated documents are expected and not listed.
 */
export function compareShapes(a: ExpenseShape, b: ExpenseShape, labels: [string, string] = ["A", "B"]): string[] {
  const out: string[] = [];
  const [la, lb] = labels;
  for (const k of a.headerKeys.filter((x) => !b.headerKeys.includes(x))) out.push(`header field "${k}" only in ${la}`);
  for (const k of b.headerKeys.filter((x) => !a.headerKeys.includes(x))) out.push(`header field "${k}" only in ${lb}`);
  const kind = (v: unknown) => (typeof v === "string" && /%\s*$/.test(v) ? "percent" : typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim()) ? "amount-string" : typeof v);
  const n = Math.min(a.lines.length, b.lines.length);
  for (let i = 0; i < n; i++) {
    const fa = a.lines[i].fields, fb = b.lines[i].fields;
    for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
      if (k === "description" || k === "price" || k === "id") continue;
      const va = fa[k], vb = fb[k];
      if (!(k in fb)) out.push(`line ${i + 1}: "${k}" only in ${la} (${JSON.stringify(va)})`);
      else if (!(k in fa)) out.push(`line ${i + 1}: "${k}" only in ${lb} (${JSON.stringify(vb)})`);
      else if (isBlank(va) !== isBlank(vb)) out.push(`line ${i + 1}: "${k}" is ${JSON.stringify(va)} in ${la} but ${JSON.stringify(vb)} in ${lb}`);
      else if (!isBlank(va) && kind(va) !== kind(vb)) out.push(`line ${i + 1}: "${k}" is a ${kind(va)} in ${la} (${JSON.stringify(va)}) but a ${kind(vb)} in ${lb} (${JSON.stringify(vb)})`);
    }
  }
  if (a.payments.length !== b.payments.length) out.push(`${la} has ${a.payments.length} payment(s), ${lb} has ${b.payments.length}`);
  for (let i = 0; i < Math.min(a.payments.length, b.payments.length); i++) {
    const fa = a.payments[i].fields, fb = b.payments[i].fields;
    for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
      if (!(k in fb)) out.push(`payment ${i + 1}: "${k}" only in ${la} (${JSON.stringify(fa[k])})`);
      else if (!(k in fa)) out.push(`payment ${i + 1}: "${k}" only in ${lb} (${JSON.stringify(fb[k])})`);
      else if (!/amount|total|date|(^|\.)id$|Id$|code$/i.test(k) && isBlank(fa[k]) !== isBlank(fb[k])) out.push(`payment ${i + 1}: "${k}" is ${JSON.stringify(fa[k])} in ${la} but ${JSON.stringify(fb[k])} in ${lb}`);
    }
  }
  return out;
}
