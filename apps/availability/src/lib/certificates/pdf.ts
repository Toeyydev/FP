// Turning the certificate's HTML into a PDF, on the server.
//
// Every other PDF in FolkOPS is made in the operator's browser by html2pdf and posted
// back as base64. That is fine for a job sheet somebody printed. It is not fine here:
// a file hash is only worth something if the server made the bytes it is hashing, and
// bytes that arrive from a browser are bytes the browser chose.
//
// Thai is why this is Chromium and not a PDF library. Thai stacks vowels above and below
// consonants and moves tone marks depending on what is underneath; getting that right is
// text shaping, and the Node PDF libraries do not do it — they would lay the marks out
// wrongly and the document would be quietly incorrect in a way nobody reviewing English
// test output would notice.
//
// Chromium is not bundled. The deployment provides one and names it in an environment
// variable; without it this throws and the caller keeps the certificate at SIGNED, which
// is a state the workflow can recover from.

import type { Browser } from "puppeteer-core";

export const PDF_UNAVAILABLE = "pdf-renderer-unavailable";

/** Where the deployment put its Chromium. Set in Railway; absent in tests. */
const chromiumPath = () =>
  (process.env.CHROMIUM_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? "").trim();

export const pdfRendererAvailable = () => Boolean(chromiumPath());

export type RenderPdf = (html: string) => Promise<Buffer>;

/**
 * Render one page of HTML to a PDF.
 *
 * Everything that could vary between two runs of the same input is pinned: no header or
 * footer (Chromium's carry a print date), a fixed page size, and backgrounds on so the
 * document looks the way it does on screen. The HTML itself carries no clock.
 */
export const renderPdf: RenderPdf = async (html) => {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error(PDF_UNAVAILABLE);

  const puppeteer = (await import("puppeteer-core")).default;
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      // Containers get a small /dev/shm; without this Chromium dies on bigger pages.
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    return Buffer.from(pdf);
  } finally {
    await browser?.close().catch(() => {});
  }
};

/** The name the file is filed under. Deterministic, so a retry replaces rather than duplicates. */
export function certificateFileName(certificateNo: string): string {
  return `${certificateNo}.pdf`;
}

/** Where it is filed. Beside the job sheets it belongs to, in its own folder. */
export function certificateFolder(tourDate: string): string[] {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = `${tourDate.slice(0, 7)} ${MONTHS[Number(tourDate.slice(5, 7)) - 1] ?? ""}`.trim();
  return ["Folkpaths Job Sheets", month, "Expense Certificates"];
}
