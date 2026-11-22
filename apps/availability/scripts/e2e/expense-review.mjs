// Guide and operator job sheet expenses together, in a real browser (owner 2026-11-15):
//   GUIDE (390 px): Tour expenses are exactly Water / Bus / Ferry (no add, no rename); a ticket
//     line is refused by the server; Company ADV ticket rows are not tour expenses — they sit
//     under Ticket receipts, upload-only; no "Waiting for review" chip on a new report; the
//     three figures go straight onto the job sheet's rows (owner, 22 Nov 2026).
//   OPERATOR: no "Tour expenses · guide report" review panel on the job sheet (owner, 22 Nov
//     2026) — the guide's three items are compared below the job's rows. Company ADV — Entrance
//     tickets: the advance summary and Verify / Ask for a new receipt; verifying never settles.
//   A guide cannot call either review. No page scrolls sideways at 390 px.
// Run after `next build`:  node scripts/e2e/expense-review.mjs   All data invented.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const url = process.env.DATABASE_URL ?? "";
if (!url || (/railway|amazonaws|supabase|\.com\b/i.test(url) && !/test/i.test(url))) {
  console.error("refusing to run: DATABASE_URL must be a throwaway test database (this truncates tables)");
  process.exit(2);
}
const PORT = Number(process.env.E2E_PORT ?? 3992);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
writeFileSync(OUTBOUND, "");
const PASSWORD = "e2e-password-not-real-1";

const prisma = new PrismaClient();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

function browserPath() {
  const root = join(appDir, ".browser-cache", "chrome-headless-shell");
  for (const build of readdirSync(root)) for (const dir of readdirSync(join(root, build))) {
    const exe = join(root, build, dir, "chrome-headless-shell");
    if (existsSync(exe)) return exe;
  }
  throw new Error("managed browser not installed — npm run browser:install");
}

// ── data ─────────────────────────────────────────────────────────────────────

// ── data (invented) ──────────────────────────────────────────────────────────
const DATE = "2026-01-10"; // past: a guide reports only once the tour date has come
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";

async function seed() {
  const tables = ["AuditLog", "Notification", "ServiceStatus", "AdvancePeakDocumentLink", "AdvancePeakSync", "GuideAdvanceEntry", "GuideAdvanceRefund", "GuideAdvanceReceipt", "GuideAdvanceReturn", "GuideAdvance",
    "ExpenseAttachment", "ExpenseCertificate", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-903", name: "Old Town Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const guide = await prisma.user.create({ data: { email: "g-961@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: "G-961", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const op = await prisma.user.create({ data: { email: "op-961@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: "G-961", date: DATE, slotIdx: 0, tourId: "T-903", pax: 5 } });
  const sheet = await prisma.jobSheet.create({ data: { ref: "FOLK-BKK-20260110-01", guideId: "G-961", date: DATE, slotIdx: 0, tourId: "T-903", status: "Confirmed",
    bookings: [{ name: "Guest Example", bookingNo: "VIA-ER-1", bookedPax: 5, actualPax: 5, tickets: "", status: "" }],
    expenses: [
      { rowId: "r_water", description: "Water (Inc. Guide)", expenseType: "meal", price: 10, pax: 6 },
      { rowId: "r_bus", description: "Bus (Inc. Guide)", expenseType: "transport", price: 15, pax: 6 },
      { rowId: "r_gp", description: "Grand Palace", expenseType: "entrance", price: 500, pax: 5, paidBy: "advance" },
      { rowId: "r_wp", description: "Wat Pho", expenseType: "entrance", price: 300, pax: 5, paidBy: "advance" },
    ] } });
  await prisma.expenseAttachment.create({ data: { jobSheetId: sheet.id, expenseRowId: "r_gp", originalName: "grand-palace.jpg", mimeType: "image/jpeg", sizeBytes: 10, sha256: "e2e-gp", status: "UPLOADED", driveLink: "https://example.test/gp", uploadedByRole: "GUIDE" } });
  const adv = await prisma.guideAdvance.create({ data: { guideId: "G-961", date: DATE, slotIdx: 0, amount: 4000, paidAt: new Date(`${DATE}T01:00:00Z`), method: "bank", txRef: "TX-ER-1", advanceNo: "FOLK-ADV-202601-001", advanceDate: "2026-01-09", amountSatang: 400000, accountingPeriod: "2026-01", jobNo: "FOLK-BKK-20260110-01", allowedCategories: ["entrance"] } });
  return { guide, op, sheet, adv };
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET, ADVANCE_WRITES_FROZEN: "", PEAK_ADVANCE_AUTO_SYNC: "" },
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error(`server did not start:\n${log.slice(-2000)}`);
}

async function sessionCookie(email) {
  const c = await fetch(`${BASE}/api/auth/csrf`);
  const jar = (c.headers.getSetCookie?.() ?? []).map((s) => s.split(";")[0]);
  const { csrfToken } = await c.json();
  const r = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: "true" }) });
  const session = [...jar, ...(r.headers.getSetCookie?.() ?? []).map((s) => s.split(";")[0])].find((s) => /session-token=/.test(s));
  if (!session) throw new Error(`could not sign in as ${email} (${r.status})`);
  const at = session.indexOf("=");
  return { name: session.slice(0, at), value: session.slice(at + 1), domain: "localhost", path: "/" };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const SHEET_URL = `${BASE}/job-sheet?guideId=G-961&date=${DATE}&slotIdx=0`;
const KEY = { guideId: "G-961", date: DATE, slotIdx: 0 };
const sheetRow = () => prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: KEY } });
const byDesc = (rows, d) => (rows ?? []).filter((r) => r.description === d);
async function open(user, width) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, isMobile: width < 500, hasTouch: width < 500 });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(user.email));
  await page.goto(SHEET_URL, { waitUntil: "networkidle0" });
  await pause(1500);
  return { page, errors };
}
const tap = async (page, sel) => { await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" })); await pause(150); await page.click(sel); };
const setVal = async (page, sel, v) => { await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" })); const h = await page.$(sel); await h.click({ clickCount: 3 }); await page.keyboard.press("Backspace"); if (v !== "") await h.type(v); };
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  const gCookie = await sessionCookie(data.guide.email);
  const asGuide = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${gCookie.name}=${gCookie.value}` }, body: JSON.stringify(body) });

  // ── GUIDE ────────────────────────────────────────────────────────────────────────────────
  {
    const { page, errors } = await open(data.guide, 390);
    const items = await page.$$eval(".js-fixed-item", (xs) => xs.map((x) => x.getAttribute("data-item")));
    check("guide: Tour expenses are exactly Water, Bus, Ferry", JSON.stringify(items) === JSON.stringify(["WATER", "BUS", "FERRY"]), JSON.stringify(items));
    const free = await page.evaluate(() => ({ add: [...document.querySelectorAll("button")].some((b) => /\+ Add expense/.test(b.textContent)), nameInputs: document.querySelectorAll(".js-guide-tour-expenses input:not([type=number])").length }));
    check("guide: no way to add or rename an item", !free.add && free.nameInputs === 0, JSON.stringify(free));
    const listed = await page.$$eval(".gs-exp li", (xs) => xs.map((x) => x.innerText));
    check("guide: Company ADV tickets are not in the expense list", !listed.some((l) => /Grand Palace|Wat Pho/.test(l)), JSON.stringify(listed));
    const tickets = await page.$$eval(".js-ticket-row", (xs) => xs.map((x) => `${x.querySelector("b")?.textContent}|${x.getAttribute("data-status")}`));
    check("guide: Ticket receipts list the ADV rows, upload-only (Grand Palace uploaded, Wat Pho missing)", JSON.stringify(tickets) === JSON.stringify(["Grand Palace|TO_REVIEW", "Wat Pho|MISSING"]), JSON.stringify(tickets));

    for (const [k, price, qty] of [["Water", "10", "6"], ["Bus", "15", "6"], ["Ferry", "8", "6"]]) {
      await setVal(page, `input[aria-label="${k} price"]`, price);
      await setVal(page, `input[aria-label="${k} quantity"]`, qty);
    }
    await tap(page, ".js-fixed-submit");
    await pause(1500);
    const stored = (await sheetRow()).guideExpenses;
    check("guide: submitting stores the three items under their fixed names", JSON.stringify(stored.map((r) => [r.description, r.price, r.pax])) === JSON.stringify([["Water (Inc. Guide)", 10, 6], ["Bus (Inc. Guide)", 15, 6], ["Ferry (Inc. Guide)", 8, 6]]), JSON.stringify(stored));
    {
      const rowsNow = (await sheetRow()).expenses;
      const fig = (d) => byDesc(rowsNow, d).map((e) => `${e.price}x${e.pax}`).join(",");
      check("guide: the three figures go straight onto the job sheet rows (no review step)",
        fig("Water (Inc. Guide)") === "10x6" && fig("Bus (Inc. Guide)") === "15x6" && fig("Ferry (Inc. Guide)") === "8x6"
          && byDesc(rowsNow, "Grand Palace").length === 1 && byDesc(rowsNow, "Grand Palace")[0].price === 500,
        JSON.stringify(rowsNow.map((e) => [e.description, e.price, e.pax, e.paidBy])));
    }
    check("guide: no \"Waiting for review\" chip that nobody would answer", (await page.$$(".js-fixed-status")).length === 0 && !(await page.evaluate(() => /Waiting for review/.test(document.body.innerText))));
    check("guide: no sideways scroll at 390 px", (await noSideways(page)) <= 0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "expense-review-guide-390.png"), fullPage: true });
    check("guide: no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
    await page.close();
  }
  {
    const before = JSON.stringify((await sheetRow()).guideExpenses);
    const r = await asGuide("/api/jobsheet/expenses", { ...KEY, expenses: [{ description: "Grand Palace", price: 500, pax: 5 }] });
    check("server: a guide's ticket line is refused and nothing changes", r.status === 400 && JSON.stringify((await sheetRow()).guideExpenses) === before, String(r.status));
    const a = await asGuide("/api/jobsheet/expense-review", { ...KEY, item: "WATER", action: "APPROVE" });
    const b = await asGuide("/api/jobsheet/receipt-review", { ...KEY, rowId: "r_gp", action: "VERIFY" });
    check("server: a guide cannot review expenses or receipts", a.status === 403 && b.status === 403, `${a.status}/${b.status}`);
  }

  // ── OPERATOR ─────────────────────────────────────────────────────────────────────────────
  {
    const { page, errors } = await open(data.op, 1280);
    check("operator: the old whole-report \"Accept guide's figures\" is not offered for a fixed-item report", !(await page.evaluate(() => /Accept guide.s figures/.test(document.body.innerText))));
    check("operator: no \"Tour expenses · guide report\" review panel on the job sheet", !(await page.$(".js-review-expenses")) && (await page.$$(".js-review-row")).length === 0 && !(await page.evaluate(() => /Fixed items · PEAK accounts/.test(document.body.innerText))));

    const adv = await page.$eval(".js-review-adv", (x) => x.innerText).catch(() => "");
    check("operator: the Company ADV panel shows the advance, the transfer and settlement", /FOLK-ADV-202601-001/.test(adv) && /฿4,000\.00/.test(adv) && /✓ Transferred/.test(adv) && /Settlement/.test(adv) && /Not tour expenses/.test(adv), adv.slice(0, 200));
    await tap(page, '.js-adv-receipt-row:nth-of-type(1) .js-adv-verify');
    await page.waitForFunction(() => document.querySelector(".js-adv-receipt-row")?.getAttribute("data-status") === "VERIFIED", { timeout: 10000 }).catch(() => {});
    const att = await prisma.expenseAttachment.findFirst();
    const advRow = await prisma.guideAdvance.findUniqueOrThrow({ where: { id: data.adv.id } });
    check("operator: Verify marks the receipt verified and does not settle the advance", att.reviewStatus === "VERIFIED" && advRow.settledSatang === 0 && (await prisma.guideAdvanceEntry.count()) === 0, `${att.reviewStatus} / ${advRow.settledSatang}`);
    await setVal(page, '.js-adv-receipt-row:nth-of-type(2) .js-adv-note', "Please upload the Wat Pho receipt");
    await tap(page, '.js-adv-receipt-row:nth-of-type(2) .js-adv-request');
    await pause(1200);
    const asked = await prisma.auditLog.count({ where: { action: "receipt.review" } });
    check("operator: Ask for a new one is recorded", asked === 2, String(asked));
    check("operator: no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "expense-review-operator-1280.png"), fullPage: true });
    await page.close();
  }
  {
    const { page } = await open(data.op, 390);
    check("operator: no sideways page scroll at 390 px (tables scroll in their box)", (await noSideways(page)) <= 0, String(await noSideways(page)));
    await page.close();
  }

  // ── GUIDE sees the verdicts ───────────────────────────────────────────────────────────────
  {
    const { page } = await open(data.guide, 390);
    const tickets = await page.$$eval(".js-ticket-row", (xs) => xs.map((x) => x.getAttribute("data-status")));
    check("guide: the Grand Palace receipt shows Verified", tickets[0] === "VERIFIED", JSON.stringify(tickets));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "expense-review-guide-after-390.png"), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nexpense review e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
