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
// The browser is downloaded by build id into a directory inside the project (see
// lib/certificates/browser) and found by computing where that download put it — never by
// searching the machine for something that looks like Chrome. Without it this throws and
// the caller keeps the certificate at ATTESTED, which the workflow can recover from.

import type { Browser } from "puppeteer-core";
import { findExecutable } from "@/lib/certificates/browser";

export const PDF_UNAVAILABLE = "pdf-renderer-unavailable";

/**
 * Is there a browser to render with?
 *
 * This is a FILE question and nothing more — the file exists, is a file, and may be run.
 * It is not the same as "the renderer works": a browser missing a shared library passes
 * this and dies on launch. Whether it works is `lib/certificates/probe`, which finds out
 * by rendering something. Health reports that one; this one only decides whether it is
 * worth trying.
 */
export const pdfRendererAvailable = () => findExecutable().ok;

export type RenderPdf = (html: string) => Promise<Buffer>;

/**
 * What the page is allowed to fetch while it renders: nothing.
 *
 * The document is one self-contained page — no stylesheet, no image, no font, no script
 * comes from anywhere. Leaving the network open would mean an expense description
 * someone typed could reach out: a tracking pixel that says when an accountant opened
 * the file, an external stylesheet that changes what the page says after it is approved,
 * or a `file://` read of something on the server. None of that is hypothetical enough to
 * leave to the escaping alone, so every request other than the document itself is
 * aborted, and rendering does not depend on anything outside this process.
 */
export const BLOCKED_SCHEMES = ["http:", "https:", "file:", "ftp:", "ws:", "wss:"];

/**
 * Render one page of HTML to a PDF.
 *
 * Everything that could vary between two runs of the same input is pinned: no header or
 * footer (Chromium's carry a print date), a fixed page size, and backgrounds on so the
 * document looks the way it does on screen. The HTML itself carries no clock.
 */
/**
 * One render at a time.
 *
 * Each render is a whole browser process. Two at once on a small container is the
 * difference between a slow certificate and an out-of-memory kill that takes the web
 * process with it, and certificates are issued one at a time by a person clicking a
 * button — there is nothing to gain from overlapping them. v1 queues instead.
 */
let renderQueue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(fn, fn);
  renderQueue = run.catch(() => {});
  return run;
}

export const renderPdf: RenderPdf = (html) => queued(() => renderOnce(html));

/** The error a caller sees when there is nothing to render with. Carries no path. */
export class RendererUnavailable extends Error {
  constructor(public code: string) {
    super(`${PDF_UNAVAILABLE}: ${code}`);
    this.name = "RendererUnavailable";
  }
}

const renderOnce: RenderPdf = async (html) => {
  const exe = findExecutable();
  if (!exe.ok) throw new RendererUnavailable(exe.code);
  const executablePath = exe.path;

  const puppeteer = (await import("puppeteer-core")).default;
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      // Containers get a small /dev/shm; without this Chromium dies on bigger pages.
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    });
    const page = await browser.newPage();
    // Nothing leaves this process. The only request allowed through is the document
    // itself, which is the string below and never travels.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && url.startsWith("data:")) return void req.continue();
      if (url.startsWith("data:") && req.resourceType() !== "document") return void req.continue();
      void req.abort();
    });
    await page.setJavaScriptEnabled(false);
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
