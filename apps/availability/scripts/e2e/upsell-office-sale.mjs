// Owner, 22 Nov 2026, in a real browser: the guide tells the office a guest paid on the tour (the 2
// temples, ฿200) and the office records it on the Job Sheet for the guide — with a reason and the
// day the cash was received; the guide hands it in with ref = the Job Ref (slip only); an Admin
// checks the slip and confirms it ON THE JOB SHEET. 1280 and 390 px. Invented data only.
//
// Run after `next build`:  node scripts/e2e/upsell-office-sale.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { tmpdir } from "node:os";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const url = process.env.DATABASE_URL ?? "";
if (!url || (/railway|amazonaws|supabase|\.com\b/i.test(url) && !/test/i.test(url))) {
  console.error("refusing to run: DATABASE_URL must be a throwaway test database (this truncates tables)");
  process.exit(2);
}
const PORT = Number(process.env.E2E_PORT ?? 3994);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
writeFileSync(OUTBOUND, "");
const PASSWORD = "e2e-password-not-real-1";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const ADMIN = "admin-cash@example.test", GUIDE = "g986@example.test", OPS = "ops-cash@example.test";
const GUIDE_ID = "G-986", TOUR = "T-002", SLOT = 2; // full three temples, afternoon
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
// What the Admin reads off the slip: half an hour ago, Bangkok time. A fixed clock time (09:15)
// is "in the future" — refused by the server — whenever the run starts before 09:15 in Bangkok.
const SLIP_AT = new Date(Date.now() - 30 * 60_000 + 7 * 3600_000).toISOString();
const SLIP_DATE = SLIP_AT.slice(0, 10), SLIP_TIME = SLIP_AT.slice(11, 16);
const PAST = new Date(Date.now() + 7 * 3600_000 - 3 * 86400_000).toISOString().slice(0, 10);
const JOB_PATH = `/job-sheet?guideId=${GUIDE_ID}&date=${PAST}&slotIdx=${SLOT}`;

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

function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
const SLIP = join(tmpdir(), "fp-e2e-office-slip.png");
writeFileSync(SLIP, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

// ── data ─────────────────────────────────────────────────────────────────────
async function seed() {
  const tables = ["AuditLog", "Notification", "UpsellPeakEventBankLink", "UpsellPeakEvent", "UpsellSaleReversal", "CashSettlementSubmission", "CashSettlementTransfer", "UpsellReceivingAccount",
    "BankTransactionRelease", "BankTransactionUse", "BankTransaction", "PaymentEvidence", "GoogleCalendar",
    "CashCustodyEntry", "CashSettlementReturn", "CashSettlement", "UpsellPayment", "UpsellSale",
    "UpsellProductVersion", "UpsellProduct", "TaxProfile", "UpsellDocCounter", "TourReport", "Checkin", "JobSheet", "JobRefCounter",
    "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const r = spawnSync(process.execPath, [join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], {
    cwd: appDir, encoding: "utf8", env: { ...process.env, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: PASSWORD },
  });
  check("the deploy seed runs", r.status === 0, r.status === 0 ? "" : (r.stderr || r.stdout).slice(-600));
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: GUIDE, displayName: "Fah Example", fullName: "Fah Example", guideId: GUIDE_ID, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: OPS, displayName: "Operator Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("e2e-refresh-token"), email: ADMIN } });
  const from = new Date(Date.now() - 10 * 86400_000);
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR], activeFrom: from } });
  await prisma.upsellProductVersion.updateMany({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } }, data: { activeFrom: from } });
  await prisma.upsellProduct.updateMany({ where: { productCode: { in: ["RTE-WPWA", "THREE-TEMPLES-ONSITE"] } }, data: { active: true } });
  await prisma.upsellReceivingAccount.create({ data: { version: 1, label: "Folkpaths Extras (example)", peakPaymentMethodId: "pm-e2e", bankAccountKey: "ACC:999007890", accountDisplay: "···7890", confirmedById: admin.id, confirmedAt: new Date() } });
  // A tour three days ago, report sent: a guest who booked the palace only paid the guide ฿200 for
  // the 2 temples, and the guide told the office instead of pressing Sell.
  await prisma.assignment.create({ data: { guideId: GUIDE_ID, date: PAST, slotIdx: SLOT, tourId: TOUR, pax: 2 } });
  await prisma.booking.create({ data: { source: "bokun", externalId: "e2e-office-a", confirmationCode: "INV-OFFICE-1", tourId: TOUR, date: PAST, slotIdx: SLOT, pax: 2, status: "ASSIGNED", customerName: "Invented Guest P", rateTitle: "Invented Grand Palace only (rate)" } });
  await prisma.tourReport.create({ data: { guideId: GUIDE_ID, date: PAST, slotIdx: SLOT, tourId: TOUR } });
  return prisma.jobSheet.create({ data: { guideId: GUIDE_ID, date: PAST, slotIdx: SLOT, tourId: TOUR, bookings: [{ name: "Invented Guest P", bookingNo: "INV-OFFICE-1", bookedPax: 2 }] } });
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", FAKE_DRIVE_LOG: join(appDir, ".e2e-drive.log"), AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      // This throwaway server only: the master switch and the Route Extension's, so the guide
      // can sell. Production keeps every switch off. PEAK, payment link and the rest stay off.
      UPSELL_ENABLED: "1", UPSELL_ROUTE_EXTENSION_ENABLED: "1", UPSELL_FOOD_TOUR_ENABLED: "", UPSELL_ONSITE_TOUR_ENABLED: "1",
      UPSELL_PAYMENT_LINK_ENABLED: "", UPSELL_PEAK_AUTO_SYNC: "", PEAK_ADVANCE_AUTO_SYNC: "" },
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
async function tap(page, sel) {
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
  await page.click(sel);
}

const goto = async (page, path) => { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30000 }); await new Promise((r) => setTimeout(r, 500)); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `upsell-office-${name}.png`), fullPage: true }); };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const held = async () => (await prisma.cashCustodyEntry.aggregate({ where: { custodianId: GUIDE_ID }, _sum: { amountSatang: true } }))._sum.amountSatang ?? 0;

let server, browser;
try {
  const sheet = await seed();
  server = await startServer();
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });

  // ── The office (Admin, desktop) records the sale on the Job Sheet ──
  const desk = await (await browser.createBrowserContext()).newPage();
  await desk.setCookie(await sessionCookie(ADMIN));
  await desk.setViewport({ width: 1280, height: 900 });
  const setVal = (sel, val) => desk.$eval(sel, (el, v) => { const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }, val);
  await goto(desk, JOB_PATH);
  await desk.waitForSelector(".js-office-sale-open", { timeout: 15000 });
  check("a past job with no sale: the Job Sheet offers + Record a sale for the guide…", /No extras on this job/.test(await text(desk, ".js-extras-staff")));
  await shot(desk, "empty-1280");
  await tap(desk, ".js-office-sale-open");
  await desk.waitForSelector(".js-office-sale");
  const kinds = await text(desk, ".js-office-sale");
  check("both kinds are offered: the 2 temples (฿200) and the tour paid on site (฿700)", /Wat Pho/i.test(kinds) && /฿200/.test(kinds) && /฿700/.test(kinds), kinds.slice(0, 300));
  check("the cash date defaults to the tour day", (await desk.$eval(".js-office-sale-date", (el) => el.value)) === PAST);
  await setVal(".js-office-sale-alloc", "1");
  check("1 guest → ฿200", (await text(desk, ".js-office-sale-total")).includes("฿200"));
  check("Record sale stays off without a reason", await desk.$eval(".js-office-sale-save", (b) => b.disabled) === true);
  await desk.type(".js-office-sale-reason", "Guide told us by LINE: 1 guest joined the 2 temples (example)");
  await shot(desk, "form-1280");
  await tap(desk, ".js-office-sale-save");
  await desk.waitForSelector(".js-office-sale-done", { timeout: 10000 });
  const sale = await prisma.upsellSale.findFirst({ include: { payments: true } });
  const ref = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } })).ref;
  check("saved: the sale is the guide's cash (custody), made by the Admin, ฿200",
    sale?.grossSatang === 20000 && sale.sellingGuideId === GUIDE_ID && sale.createdById === admin.id && sale.payments[0]?.cashCollectorId === GUIDE_ID && (await held()) === 20000);
  const done = await text(desk, ".js-office-sale-done");
  check("the office is told the guide hands it in with ref = the Job Ref", !!ref && done.includes(ref), done);
  await desk.waitForSelector(".js-extras-sale", { timeout: 10000 });
  check("the Job Sheet now lists the sale", (await text(desk, ".js-extras-sales")).includes(sale?.saleNo ?? "missing"));
  const audit = await prisma.auditLog.findFirst({ where: { action: "upsell.sale.recorded_by_office" } });
  check("audit: who, for which guide, why, the cash date", audit?.actorId === admin.id && audit.detail?.forGuideId === GUIDE_ID && /told us by LINE/.test(audit.detail?.reason ?? "") && audit.detail?.receivedOn === PAST);
  await shot(desk, "recorded-1280");

  // ── Phone width: the form fits ──
  const phone = await (await browser.createBrowserContext()).newPage();
  await phone.setCookie(await sessionCookie(ADMIN));
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(phone, JOB_PATH);
  await phone.waitForSelector(".js-office-sale-open", { timeout: 15000 });
  await tap(phone, ".js-office-sale-open");
  await phone.waitForSelector(".js-office-sale");
  const f0 = await fits(phone);
  check("390 px (office form): nothing pushes the page sideways", f0.over <= 0, f0.culprits.join(" "));
  await shot(phone, "form-390");

  // ── An operator may record too; an accountant may not (the API refuses) ──
  const opCookie = await sessionCookie(OPS);
  const offer = await (await fetch(`${BASE}/api/upsell/jobs/office-extras?jobSheetId=${sheet.id}`, { headers: { cookie: `${opCookie.name}=${opCookie.value}` } })).json();
  check("an operator is offered the same", offer.canRecord === true && offer.extras?.products?.length === 2);

  // ── The guide hands it in: slip only, ref = the Job Ref ──
  const guide = await browser.newPage();
  await guide.setCookie(await sessionCookie(GUIDE));
  await guide.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(guide, JOB_PATH);
  await guide.waitForSelector(".js-handin", { timeout: 15000 });
  check("the guide sees the office's sale to hand in, with ref.โอนเงิน = the Job Ref", (await text(guide, ".js-handin .ups-transfer-ref-code")).trim() === ref && (await text(guide, ".ups-code")).includes(sale?.saleNo ?? "missing"));
  await (await guide.$(".ups-upload input[type=file]")).uploadFile(SLIP);
  await guide.waitForSelector(".ups-slip", { timeout: 15000 });
  await tap(guide, ".ups-send");
  await guide.waitForFunction(() => /ส่งสลิปแล้ว รอบริษัทตรวจ/.test(document.querySelector(".js-handin")?.textContent ?? ""), { timeout: 10000 });

  // ── The Admin checks the slip and confirms it on the Job Sheet ──
  await goto(desk, JOB_PATH);
  await desk.waitForSelector(".js-handin-check", { timeout: 15000 });
  check("once sent, the Job Sheet offers the Admin the check — and no more office sales on this job", !(await desk.$(".js-office-sale-open")));
  await shot(desk, "check-1280");
  await tap(desk, ".js-handin-check");
  await desk.waitForSelector(".js-slip-review");
  check("the check shows ref.โอนเงิน = the Job Ref", (await text(desk, ".js-slips-dialog")).includes(ref));
  await setVal('.js-slip-review input[aria-label="Amount on the slip"]', "200");
  await setVal('.js-slip-review input[aria-label="Bank reference"]', "KB E2E 0001 0200");
  await setVal('.js-slip-review input[aria-label="Date on the slip"]', SLIP_DATE);
  await setVal('.js-slip-review input[aria-label="Time on the slip"]', SLIP_TIME);
  await desk.click(".js-recipient-ok");
  await desk.click(".js-slip-save");
  await desk.waitForSelector(".js-slip-tick", { timeout: 10000 });
  await desk.click(".js-slip-tick");
  await desk.waitForFunction(() => document.querySelector(".js-slips-confirm")?.disabled === false, { timeout: 10000 });
  await desk.click(".js-slips-confirm");
  await desk.waitForFunction(() => /confirmed/.test(document.querySelector(".js-extras-staff")?.textContent ?? ""), { timeout: 15000 });
  const st = await prisma.cashSettlement.findFirst();
  check("confirmed from the Job Sheet: the hand-in is CONFIRMED and the guide holds nothing", st?.status === "CONFIRMED" && (await held()) === 0, st?.status);
  await goto(desk, JOB_PATH);
  await desk.waitForSelector(".js-extras-staff");
  check("the Job Sheet shows the company has the money", /บริษัทได้รับเงินแล้ว|Received/i.test(await text(desk, ".js-extras-staff")));
  await shot(desk, "confirmed-1280");
  check("no request left this machine (PEAK and the rest stay off)", readFileSync(OUTBOUND, "utf8").trim() === "", readFileSync(OUTBOUND, "utf8").slice(0, 300));
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
