// A JPEG photo of a receipt, wrapped as a one-page A4 PDF — so every file in a job's
// folder is a PDF (owner, 2026-11-06). The JPEG is embedded as it is (DCTDecode): no
// re-encoding, no quality lost, nothing to install. A PDF passes through untouched.

export type JpegInfo = { width: number; height: number; components: number; adobe: boolean };

/** Size and colour layout from the JPEG's frame header; null when it is not a usable JPEG. */
export function jpegInfo(b: Uint8Array): JpegInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2, adobe = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    if (m === 0xee && String.fromCharCode(...b.slice(i + 4, i + 9)) === "Adobe") adobe = true;
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6], width = (b[i + 7] << 8) | b[i + 8], components = b[i + 9];
      if (!width || !height || ![1, 3, 4].includes(components)) return null;
      return { width, height, components, adobe };
    }
    if (m === 0xda) return null; // image data before any frame header
    i += 2 + len;
  }
  return null;
}

const A4 = { w: 595.28, h: 841.89 }, MARGIN = 28;
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1").slice(0, 120);

/** A one-page A4 PDF showing the JPEG as large as fits, centred. Null for anything else. */
export function jpegToPdf(jpeg: Uint8Array, title = "Receipt"): Uint8Array | null {
  const info = jpegInfo(jpeg);
  if (!info) return null;
  const scale = Math.min((A4.w - 2 * MARGIN) / info.width, (A4.h - 2 * MARGIN) / info.height);
  const w = +(info.width * scale).toFixed(2), h = +(info.height * scale).toFixed(2);
  const x = +((A4.w - w) / 2).toFixed(2), y = +((A4.h - h) / 2).toFixed(2);
  const cs = info.components === 1 ? "/DeviceGray" : info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
  // Adobe CMYK JPEGs are stored inverted.
  const decode = info.components === 4 && info.adobe ? " /Decode [1 0 1 0 1 0 1 0]" : "";
  const content = `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q`;

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (p: Uint8Array | string) => { const u = typeof p === "string" ? enc.encode(p) : p; parts.push(u); len += u.length; };
  const obj = (n: number, body: string | (Uint8Array | string)[]) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`);
    for (const p of Array.isArray(body) ? body : [body]) push(p);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  obj(5, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`);
  obj(6, `<< /Title (${ascii(title)}) /Producer (FolkOPS) >>`);
  const xref = len;
  push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
