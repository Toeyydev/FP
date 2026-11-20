// Walk-in seat (manual and guest QR) in a real browser against a real server and database
// (mockups pr4w + pr4q, approved with Codex's corrections).
//
//  • On a Three Temples job the guide sees the walk-in seat only — the Route Extension, sold on
//    the palace tour, is not offered there (no charging for temples already included).
//  • Manual walk-in: the guide sells a seat with no name → "Walk-in · <Sale Ref>" on the guest list,
//    the payment acknowledgement and the official-receipt status (never "issued" before PEAK).
//  • Guest QR: the guide makes a QR; its image decodes to exactly the bound URL. A guest with no
//    account (own browser, 390 px) opens it, registers (WAITING — no seat, no money), the guide
//    presses "Cash received", the guest's page turns PAID with the Sale Ref; the guest is on the
//    job's guest list. A new QR makes the old link say it is no longer valid.
//  • After the end-tour report the hand-in code is shown before any transfer.
//  • The server calls nothing off this machine (no QR service, no PEAK).
//
// Run after `next build`:  node scripts/e2e/upsell-walkin-qr.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
// Every name, figure and reference here is invented — this repository is public.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jsQR from "jsqr";
import { PNG } from "pngjs";

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
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const ADMIN = "admin-walkin@example.test", GUIDE = "g986@example.test";
const GUIDE_ID = "G-986", TOUR = "T-001", SLOT = 0;
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const JOB_PATH = `/job-sheet?guideId=${GUIDE_ID}&date=${TODAY}&slotIdx=${SLOT}`;

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

async function seed() {
  const tables = ["AuditLog", "Notification", "WalkInRegistration", "WalkInQr", "UpsellPeakEventBankLink", "UpsellPeakEvent", "UpsellSaleReversal", "CashSettlementSubmission", "CashSettlementTransfer", "UpsellReceivingAccount",
    "BankTransactionRelease", "BankTransactionUse", "BankTransaction", "PaymentEvidence",
    "CashCustodyEntry", "CashSettlementReturn", "CashSettlement", "UpsellPayment", "UpsellSale",
    "UpsellProductVersion", "UpsellProduct", "TaxProfile", "UpsellDocCounter", "TourReport", "Checkin", "JobSheet", "JobRefCounter",
    "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const r = spawnSync(process.execPath, [join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], {
    cwd: appDir, encoding: "utf8", env: { ...process.env, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: PASSWORD },
  });
  check("the deploy seed runs", r.status === 0, r.status === 0 ? "" : (r.stderr || r.stdout).slice(-600));
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: GUIDE, displayName: "Mint Example", fullName: "Mint Example", guideId: GUIDE_ID, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  // The Route Extension is sold on the palace tour only; the walk-in seat on Three Temples (an
  // Admin saves its version 2 at Tour Service Revenue — here written directly, in this test DB only).
  const rte = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  await prisma.upsellProductVersion.update({ where: { id: rte.id }, data: { eligibleSourceTourIds: ["T-005"] } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  const v1 = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" }, version: 1 } });
  const { id: _i, createdAt: _c, version: _v, ...rest } = v1;
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86400_000);
  await prisma.upsellProductVersion.update({ where: { id: v1.id }, data: { activeFrom: new Date(yesterday.getTime() - 2 * 86400_000), activeTo: new Date(yesterday.getTime() - 86400_000) } });
  await prisma.upsellProductVersion.create({ data: { ...rest, version: 2, revenueCategory: "TOUR_SERVICE_REVENUE", activeFrom: yesterday, activeTo: null } });
  await prisma.upsellProduct.update({ where: { productCode: "THREE-TEMPLES-ONSITE" }, data: { active: true } });
  await prisma.assignment.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR, pax: 6 } });
  await prisma.booking.create({ data: { source: "bokun", externalId: "e2e-ota-1", confirmationCode: "E2E-OTA-1", tourId: TOUR, date: TODAY, slotIdx: SLOT, pax: 6, status: "ASSIGNED", customerName: "Invented OTA Guest" } });
  return prisma.jobSheet.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR, bookings: [{ name: "Invented OTA Guest", bookingNo: "E2E-OTA-1", bookedPax: 6, actualPax: null, tickets: "", status: "" }] } });
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", FAKE_DRIVE_LOG: join(appDir, ".e2e-drive.log"), AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      // This throwaway server only. Production keeps every switch off.
      PUBLIC_BASE_URL: BASE, E2E_ALLOW_HTTP_LOCALHOST: "1",
      UPSELL_ENABLED: "1", UPSELL_ROUTE_EXTENSION_ENABLED: "1", UPSELL_ONSITE_TOUR_ENABLED: "1", UPSELL_WALKIN_QR_ENABLED: "1",
      UPSELL_FOOD_TOUR_ENABLED: "", UPSELL_PAYMENT_LINK_ENABLED: "", UPSELL_PEAK_AUTO_SYNC: "", PEAK_ADVANCE_AUTO_SYNC: "" },
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

const fits = (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  let worst = 0; const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (!r.width || !r.height || r.right <= vw + 1 || s.visibility === "hidden" || s.display === "none" || s.position === "fixed" || inScroller(el)) continue;
    worst = Math.max(worst, Math.round(r.right - vw)); out.push(`${el.tagName.toLowerCase()}.${el.className}→${Math.round(r.right)}`);
  }
  return { over: worst, culprits: out.slice(0, 8) };
});
/** Every visible button / input in `scope` is at least 44 px tall. */
const targets = (page, scope) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} input`)]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .filter((el) => el.getBoundingClientRect().height < 44).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || el.id).trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`), scope);
async function tap(page, sel) {
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
  await page.click(sel);
}
const goto = async (page, path) => { await page.goto(path.startsWith("http") ? path : `${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30000 }); await new Promise((r) => setTimeout(r, 500)); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `walkin-${name}.png`), fullPage: true }); };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
const guestRows = async (id) => ((await prisma.jobSheet.findUniqueOrThrow({ where: { id } })).bookings ?? []);

let server, browser;
try {
  const sheet = await seed();
  server = await startServer();
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ── The guide's job: the walk-in card only ──
  const guide = await browser.newPage();
  await guide.setCookie(await sessionCookie(GUIDE));
  await guide.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(guide, JOB_PATH);
  await guide.waitForSelector(".js-upsell", { timeout: 15000 });
  const block = await text(guide, ".js-upsell");
  check("a Three Temples job offers the walk-in seat, not the Route Extension (no charge for included temples)", /Walk-in seat/.test(block) && !/Wat Pho \+ Wat Arun/.test(block), block.slice(0, 240));
  check("seats left are counted from every live guest (6 OTA of 12)", /6 of 12 seats left/.test(block));

  // ── Manual walk-in: one guest, no name ──
  await tap(guide, ".ups-sell-walkin");
  await guide.waitForSelector("#ups-lead");
  check("the lead guest's name is optional", /optional/.test(await text(guide, ".js-upsell")));
  const small = await targets(guide, ".js-upsell");
  check("walk-in sell screen: every control at least 44 px", small.length === 0, small.join(", "));
  await shot(guide, "guide-sell-390");
  await tap(guide, ".ups-confirm");
  await guide.waitForSelector(".ups-confirmation", { timeout: 15000 });
  const conf = await text(guide, ".js-upsell");
  const manualNo = (await text(guide, ".ups-sale-ref")).trim();
  check("the confirmation is a payment acknowledgement with the receipt's real status — never 'issued' before PEAK", /payment acknowledgement/i.test(conf) && /Official receipt: issued in PEAK once/.test(conf) && !/Official receipt issued/.test(conf) && /not VAT-registered/.test(conf), conf.slice(0, 300));
  check("the guest is on the job's guest list as 'Walk-in · <Sale Ref>'", (await guestRows(sheet.id)).some((r) => r.name === `Walk-in · ${manualNo}` && r.bookingNo === manualNo && r.bookedPax === 1));
  await shot(guide, "guide-manual-confirmed-390");
  await tap(guide, ".ups-back");

  // ── Guest QR ──
  await goto(guide, JOB_PATH);
  await tap(guide, ".js-qr-open");
  await guide.waitForSelector(".js-qr-image svg", { timeout: 15000 });
  const link = (await text(guide, ".js-qr-link")).trim();
  const img = await (await guide.$(".js-qr-image")).screenshot({ type: "png" });
  const png = PNG.sync.read(Buffer.from(img));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  check("the QR on the guide's screen decodes to exactly its link, on this app's origin", decoded === link && link.startsWith(`${BASE}/w/`) && /\/w\/[A-Za-z0-9_-]{32}$/.test(link), `${decoded} vs ${link}`);
  check("copy and share sit beside the QR", !!(await guide.$(".js-qr-copy")) && !!(await guide.$(".js-qr-share")));
  check("390 px (guide with QR): nothing pushes the page sideways", (await fits(guide)).over <= 0);
  await shot(guide, "guide-qr-390");

  // The guest: no account, own browser context, a phone.
  const guestCtx = await browser.createBrowserContext();
  const guest = await guestCtx.newPage();
  await guest.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(guest, link);
  await guest.waitForSelector(".js-guest-walkin", { timeout: 15000 });
  const form = await text(guest, ".js-guest-walkin");
  check("the guest sees the tour, the total per guest and seats — and no other guest or the guide's code", /฿700/.test(form) && /5 available now/.test(form) && !/Invented OTA Guest|G-986|Mint/.test(form), form.slice(0, 240));
  check("the guest reads: registration only — the seat is confirmed after the guide receives the cash", /Registration only — your seat is confirmed after your guide receives the cash/.test(form));
  check("there is no 'I paid' action for the guest", !/I paid|I’ve paid|I have paid/i.test(form));
  const gsmall = await targets(guest, ".js-guest-walkin");
  check("guest form: every control at least 44 px", gsmall.length === 0, gsmall.join(", "));
  await tap(guest, 'button[aria-label="One guest more"]');
  await guest.type("#g-name", "Invented Ana");
  check("2 guests: the total is ฿1,400", (await text(guest, ".js-guest-total")).trim() === "฿1,400");
  check("390 px (guest form): nothing pushes the page sideways", (await fits(guest)).over <= 0);
  await shot(guest, "guest-form-390");
  await tap(guest, ".js-guest-register");
  await guest.waitForSelector(".js-guest-waiting", { timeout: 15000 });
  const waiting = await text(guest, ".js-guest-status");
  check("registered: WAITING — not paid, no seat yet", /Waiting for your guide — not paid, no seat yet/.test(waiting) && /W-[0-9A-Z]{4}-[0-9A-Z]{4}/.test(waiting), waiting.slice(0, 200));
  check("the status link keeps its token out of the URL path and query", /\/w\/status$/.test(new URL(guest.url()).pathname) && !new URL(guest.url()).search);
  check("registering made no sale, cash or booking", (await prisma.upsellSale.count()) === 1 && (await prisma.cashCustodyEntry.count()) === 1 && (await prisma.booking.count({ where: { source: "walk-in" } })) === 1);
  await shot(guest, "guest-waiting-390");

  // The guide sees it and records the cash.
  await goto(guide, JOB_PATH);
  await guide.waitForSelector(".js-qr-reg", { timeout: 15000 });
  const reg = await text(guide, ".js-qr-reg");
  check("the guide sees the waiting registration with its total", /2 guests · ฿1,400/.test(reg) && /Invented Ana/.test(reg), reg.slice(0, 200));
  await shot(guide, "guide-waiting-390");
  await tap(guide, ".js-qr-cash");
  await guide.waitForFunction(() => /cash recorded/.test(document.querySelector(".js-walkin-qr")?.textContent ?? ""), { timeout: 15000 });
  check("cash received: one more sale, the guests are on the job's guest list", (await prisma.upsellSale.count()) === 2 && (await guestRows(sheet.id)).some((r) => r.name === "Invented Ana" && r.bookedPax === 2));
  const receipts = await prisma.upsellPeakEvent.count({ where: { eventKind: "RECEIPT" } });
  check("one PEAK receipt event per sale — nothing sent (sync off)", receipts === 2 && (await prisma.upsellPeakEvent.count({ where: { status: { in: ["POSTED", "SENDING"] } } })) === 0);
  await guest.reload({ waitUntil: "networkidle0" });
  await guest.waitForSelector(".js-guest-paid", { timeout: 15000 });
  const paid = await text(guest, ".js-guest-status");
  check("the guest's page now says PAID, with the Sale Ref and the receipt's real status", /Paid · you’re on the tour/.test(paid) && /FOLK-UPS-/.test(paid) && /once its office set-up is complete/.test(paid) && /not the official receipt/.test(paid), paid.slice(0, 300));
  await shot(guest, "guest-paid-390");
  await guest.setViewport({ width: 1280, height: 900 });
  await guest.reload({ waitUntil: "networkidle0" });
  await shot(guest, "guest-paid-1280");

  // A new QR: the old link says so; the paid guest stays paid.
  await goto(guide, JOB_PATH);
  await tap(guide, ".js-qr-show");
  await tap(guide, ".js-qr-renew");
  await guide.waitForFunction(() => /old one no longer works/.test(document.querySelector(".js-walkin-qr")?.textContent ?? ""), { timeout: 15000 });
  const oldPage = await guestCtx.newPage();
  await goto(oldPage, link);
  await oldPage.waitForSelector(".js-guest-closed", { timeout: 15000 });
  check("the old QR's link says it is no longer valid", /no longer valid/.test(await text(oldPage, ".js-guest-closed")));
  await guest.reload({ waitUntil: "networkidle0" });
  check("the paid guest is still PAID after the new QR", !!(await guest.$(".js-guest-paid")));
  check("an unknown QR token is a plain 404", (await fetch(`${BASE}/api/public/walk-in/${"A".repeat(32)}`)).status === 404);
  check("a guest cannot read another registration without its token", (await fetch(`${BASE}/api/public/walk-in/registration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewToken: "B".repeat(32) }) })).status === 404);

  // Desktop view of the guide's job.
  await guide.setViewport({ width: 1280, height: 900 });
  await goto(guide, JOB_PATH);
  await shot(guide, "guide-job-1280");

  // ── The end-tour report: the hand-in code before any transfer ──
  await prisma.tourReport.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR } });
  await guide.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(guide, JOB_PATH);
  await tap(guide, ".ups-prepare");
  await guide.waitForSelector(".ups-memo", { timeout: 15000 });
  const code = await text(guide, ".ups-code");
  check("after the report: the hand-in code covers both walk-in sales (฿2,100) before any transfer", /^FOLK-CSH-\d{6}-\d{3}$/.test((await text(guide, ".ups-memo")).trim()) && /฿2,100/.test(code) && (await prisma.cashSettlementTransfer.count()) === 0, code.slice(0, 240));
  await shot(guide, "guide-handin-code-390");
  check("the server called nothing off this machine (no QR service, no PEAK)", readFileSync(OUTBOUND, "utf8").trim() === "", readFileSync(OUTBOUND, "utf8").slice(0, 300));
} catch (e) {
  check("the run completed", false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser?.close();
  server?.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
