// A small, real PDF laid out like a K BIZ transfer slip — text at the same positions the
// bank prints it — so the slip reader is tested on an actual PDF, not only on items.
// ASCII only (the standard Helvetica font); every name and number is invented.
export type PdfText = { str: string; x: number; y: number };

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function textPdf(items: PdfText[]): Uint8Array<ArrayBuffer> {
  const content = items.map((i) => `BT /F1 9 Tf ${i.x} ${i.y} Td (${esc(i.str)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(out, "latin1");
  const u = new Uint8Array(new ArrayBuffer(bytes.length));
  u.set(bytes);
  return u;
}

/** A K BIZ-shaped slip: transfer `id` of `amount` on `date` (DD/MM/YYYY) to `to` at `account`. */
export function kbizSlipPdf(o: { id: string; date: string; amount: string; to: string; account: string; from?: string }): Uint8Array<ArrayBuffer> {
  return textPdf([
    { str: "Transfer Completed", x: 38, y: 703 },
    { str: "(Transaction ID :", x: 38, y: 690 }, { str: o.id, x: 192, y: 690 }, { str: ")", x: 307, y: 690 },
    { str: "Transaction Date", x: 487, y: 704 }, { str: `${o.date} 10:15`, x: 480, y: 685 },
    { str: "From", x: 38, y: 525 }, { str: "xxx-x-x1111-x", x: 38, y: 511 }, { str: o.from ?? "EXAMPLE TOURS CO.,LTD.", x: 38, y: 482 }, { str: "Kasikornbank", x: 38, y: 454 },
    { str: "/ To", x: 272, y: 525 }, { str: o.account, x: 272, y: 511 }, { str: o.to, x: 272, y: 482 }, { str: "Example Bank", x: 272, y: 454 },
    { str: o.amount, x: 520, y: 523 },
    { str: "/ Fee", x: 326, y: 400 }, { str: "0.00 Baht", x: 490, y: 400 },
    { str: "/ Total", x: 311, y: 385 }, { str: `${o.amount} Baht`, x: 472, y: 385 },
    { str: "Issued by K BIZ", x: 38, y: 37 },
  ]);
}
