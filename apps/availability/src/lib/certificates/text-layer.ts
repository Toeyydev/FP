// What a PDF says when a program reads it, rather than when a person looks at it.
//
// A certificate that looks right can still read wrong: the text layer is how a viewer
// searches it, copies from it and how an accounting system indexes it. The first Thai
// certificate from production looked perfect and, in Chrome's viewer, read
// "บริษัริ ษัท" for บริษัท — so this checks the layer itself.

import { inflateSync, constants } from "node:zlib";

/**
 * How many glyphs the PDF draws that map back to no character at all (U+0000).
 *
 * This is the actual fault, not a symptom. A glyph with no character is text that only
 * the /ActualText span can recover; poppler and Acrobat use the span, PDFium prints the
 * span AND the glyphs, PDFKit drops the glyph. Zero here means every reader has
 * something real to read. Counted from every ToUnicode CMap in the file.
 */
export function unmappedGlyphCount(pdf: Buffer): number {
  let n = 0;
  for (const cmap of toUnicodeCMaps(pdf)) {
    for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      n += (block.match(/<[0-9A-Fa-f]+>\s*<0000>/g) ?? []).length;
    }
    for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      n += (block.match(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*<0000>/g) ?? []).length;
    }
  }
  return n;
}

/** Every ToUnicode CMap in the file, decompressed. Chromium writes them Flate-encoded. */
export function toUnicodeCMaps(pdf: Buffer): string[] {
  const out: string[] = [];
  const marker = Buffer.from("stream");
  const end = Buffer.from("endstream");
  let at = 0;
  while ((at = pdf.indexOf(marker, at)) !== -1) {
    // "endstream" contains "stream"; skip it, and anything that is not a stream opener.
    if (pdf.subarray(Math.max(0, at - 3), at).toString("latin1") === "end") { at += marker.length; continue; }
    let start = at + marker.length;
    if (pdf[start] === 0x0d) start++;
    if (pdf[start] === 0x0a) start++;
    const stop = pdf.indexOf(end, start);
    if (stop === -1) break;
    const body = pdf.subarray(start, stop);
    let text: string;
    try { text = inflateSync(body, { finishFlush: constants.Z_SYNC_FLUSH }).toString("latin1"); }
    catch { text = body.toString("latin1"); }
    if (text.includes("begincmap")) out.push(text);
    at = stop + end.length;
  }
  return out;
}

/**
 * How many times `phrase` reads back from extracted text — spacing ignored, because a
 * line break can fall between any two Thai letters.
 *
 * The fault this exists for is a cluster read twice: PDFium printed "วันวั ที่ปฏิบัติบั ติงาน"
 * for วันที่ปฏิบัติงาน. That text does not contain the phrase, so it counts 0 — and a phrase
 * read out twice counts 2. Compare with how many times the page itself shows it.
 */
export function readBackCount(extracted: string, phrase: string): number {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const hay = squash(extracted), needle = squash(phrase);
  return needle ? hay.split(needle).length - 1 : 0;
}
