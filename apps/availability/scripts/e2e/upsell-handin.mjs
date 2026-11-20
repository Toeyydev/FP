// Tour Upsell PR4 in a real browser, slip only (owner, 20 Nov 2026): the guide hands in the Extras
// cash after the end-tour report: uploads the bank slip (filed to a fake Drive) and sends; nothing
// typed. An Admin (phone width) records what the slip shows (short, so it cannot be confirmed) and
// returns it; the slip stays ("do not transfer again"); the guide sends again; the Admin corrects
// the recorded amount, ticks it, confirms; the cash held goes to 0, once. Invented data only.
// Tour Upsell PR3 in a real browser against a real server and database: the guide sells
// Wat Pho + Wat Arun on their own job and takes the cash (mockup approved 19 Nov 2026).
//
//  • The Extras block on the guide's job sheet at 390 and 1280 px: fits the screen, every
//    control named, nothing interactive under 44 px.
//  • Sell 3 guests → a payment confirmation with the Sale Ref and Job Ref (read only), never
//    called a receipt; the job then shows Cash held, Amount to remit, Remit when, Remit by
//    (bank transfer only), Remittance status and Guide payout — the cash read from the ledger.
//  • A double tap records one sale.
//  • Lost connection after the server saved the sale: "Checking the status…", no new sale; the
//    pending request survives a reload and then shows the very sale that was saved.
//  • Lost before it reached the server: "Not recorded", Send again — with the same request key.
//  • The guest limit counts what is already sold; after the end-tour report nothing is sold.
//  • An operator opening the job sees no Extras block, and the API refuses them.
//  • The server makes no request to PEAK, a payment gateway or anything else off this machine.
//
// Run after `next build`:  node scripts/e2e/upsell-route-extension.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
// Every name, figure and reference here is invented — this repository is public.

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
const PORT = Number(process.env.E2E_PORT ?? 3992);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
writeFileSync(OUTBOUND, "");
const PASSWORD = "e2e-password-not-real-1";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const ADMIN = "admin-cash@example.test", GUIDE = "g985@example.test", OPS = "ops-cash@example.test";
const GUIDE_ID = "G-985", TOUR = "T-005", SLOT = 3; // Wat Phrakaew & Grand Palace, 14:00
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
// What the Admin reads off the slip: half an hour ago, Bangkok time. A fixed clock time (09:15)
// is "in the future" — refused by the server — whenever the run starts before 09:15 in Bangkok.
const SLIP_AT = new Date(Date.now() - 30 * 60_000 + 7 * 3600_000).toISOString();
const SLIP_DATE = SLIP_AT.slice(0, 10), SLIP_TIME = SLIP_AT.slice(11, 16);
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

function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
const SLIP = join(tmpdir(), "fp-e2e-handin-slip.png");
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
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR] } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  await prisma.assignment.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR, pax: 4 } });
  await prisma.booking.create({ data: { source: "manual", externalId: "e2e-handin-a", tourId: TOUR, date: TODAY, slotIdx: SLOT, pax: 4, status: "ASSIGNED", customerName: "Invented Guest A" } });
  return prisma.jobSheet.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR, bookings: [{ name: "Invented Guest A", bookedPax: 4 }] } });
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", FAKE_DRIVE_LOG: join(appDir, ".e2e-drive.log"), AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      // This throwaway server only: the master switch and the Route Extension's, so the guide
      // can sell. Production keeps every switch off. PEAK, payment link and the rest stay off.
      UPSELL_ENABLED: "1", UPSELL_ROUTE_EXTENSION_ENABLED: "1", UPSELL_FOOD_TOUR_ENABLED: "", UPSELL_ONSITE_TOUR_ENABLED: "",
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
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `upsell-handin-${name}.png`), fullPage: true }); };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const held = async () => (await prisma.cashCustodyEntry.aggregate({ where: { custodianId: GUIDE_ID }, _sum: { amountSatang: true } }))._sum.amountSatang ?? 0;

let server, browser;
try {
  const sheet = await seed();
  server = await startServer();
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ── A sale (over the API, as the app sends it), then the end-tour report ──
  const guideCookie = await sessionCookie(GUIDE);
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  // As the app sends it: the guests chosen from the job's booking, with what the guide was shown of it.
  const extras = await (await fetch(`${BASE}/api/upsell/jobs/extras?guideId=${GUIDE_ID}&date=${TODAY}&slotIdx=${SLOT}`, { headers: { cookie: `${guideCookie.name}=${guideCookie.value}` } })).json();
  const bookingRow = extras.products[0].rows[0];
  const sold = await fetch(`${BASE}/api/upsell/sales`, { method: "POST", headers: { "content-type": "application/json", cookie: `${guideCookie.name}=${guideCookie.value}` },
    body: JSON.stringify({ requestKey: "e2e-handin-sale-key-0001", jobSheetId: sheet.id, productVersionId: v.id, guests: 2, expectedUnitPriceSatang: v.unitPriceSatang, allocations: [{ bookingId: bookingRow.bookingId, guests: 2, fingerprint: bookingRow.fingerprint }] }) });
  check("a sale is recorded", sold.ok, String(sold.status));
  await prisma.tourReport.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR } });
  const owed = await held();

  const guide = await browser.newPage();
  await guide.setCookie(guideCookie);
  await guide.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(guide, JOB_PATH);
  await guide.waitForSelector(".js-handin", { timeout: 15000 });
  // One ref.โอนเงิน — the Job Ref — shown from the start; nothing is minted by reading the page.
  const sheetRef = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } })).ref;
  const memo = (await text(guide, ".js-handin .ups-transfer-ref-code")).trim();
  const codeCard = await text(guide, ".ups-code");
  check("the hand-in shows ONE ref.โอนเงิน = the Job Ref, copyable, with the sales it covers — no separate code to get", memo === sheetRef && !!(await guide.$(".js-handin .ups-copy-ref")) && !(await guide.$(".ups-prepare")) && /FOLK-UPS-/.test(codeCard) && /To hand in/.test(codeCard), `${memo} vs ${sheetRef}`);
  check("reading the page makes no hand-in document", (await prisma.cashSettlement.count()) === 0);
  check("no receiving account yet: the guide is told to keep the cash and contact Admin — no Send, no upload", !!(await guide.$(".ups-no-account")) && !(await guide.$(".ups-send")) && !(await guide.$(".ups-upload")));
  await goto(guide, JOB_PATH);
  check("after a refresh: the same ref, still no document", (await text(guide, ".js-handin .ups-transfer-ref-code")).trim() === memo && (await prisma.cashSettlement.count()) === 0);

  // The Admin sets the account (from PEAK in production; the PEAK lookup itself is tested elsewhere).
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
  await prisma.upsellReceivingAccount.create({ data: { version: 1, label: "Folkpaths Extras (example)", peakPaymentMethodId: "pm-e2e", bankAccountKey: "ACC:999007890", accountDisplay: "···7890", confirmedById: admin.id, confirmedAt: new Date() } });
  await goto(guide, JOB_PATH);
  const card = await text(guide, ".ups-code");
  check("before transferring the guide sees the memo, the job, the amount owed and the account", (await text(guide, ".js-handin")).includes(memo) && /To hand in/.test(card) && /···7890/.test(card), card.slice(0, 300));
  // Slip only (owner, 20 Nov 2026): no amount, date, time or reference to type.
  const typed = await guide.$$eval(".js-handin input:not([type=file]), .js-handin select, .js-handin textarea", (els) => els.length);
  check("slip only: the guide's hand-in has no amount, date, time or reference field", typed === 0, `${typed} field(s)`);
  await (await guide.$(".ups-upload input[type=file]")).uploadFile(SLIP);
  await guide.waitForSelector(".ups-slip", { timeout: 15000 });
  check("the slip is on the hand-in, unverified: no transfer, no bank transaction", (await prisma.cashSettlementSlip.count()) === 1 && (await prisma.cashSettlementTransfer.count()) === 0 && (await prisma.bankTransaction.count()) === 0);
  const f1 = await fits(guide);
  check("390 px (guide): nothing pushes the page sideways", f1.over <= 0, f1.culprits.join(" "));
  await shot(guide, "guide-slip-ready");
  await tap(guide, ".ups-send");
  await guide.waitForFunction(() => /ส่งแล้ว รอตรวจสอบ/.test(document.querySelector(".js-handin")?.textContent ?? ""), { timeout: 10000 });
  check("sent: ส่งแล้ว รอตรวจสอบ, cash held unchanged", (await held()) === owed);
  await shot(guide, "guide-sent");

  // ── Admin (phone width): reads the slip, records a short amount → cannot confirm → returns it ──
  // Its own browser context: the Admin's session cookie must not replace the guide's.
  const desk = await (await browser.createBrowserContext()).newPage();
  await desk.setCookie(await sessionCookie(ADMIN));
  await desk.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const setVal = (sel, val) => desk.$eval(sel, (el, v) => { const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }, val);
  const fill = async (amountBaht) => {
    await desk.waitForSelector(".js-slip-review");
    await setVal('.js-slip-review input[aria-label="Amount on the slip"]', String(amountBaht));
    await setVal('.js-slip-review input[aria-label="Bank reference"]', "KB E2E 7731 0042");
    await setVal('.js-slip-review input[aria-label="Date on the slip"]', SLIP_DATE);
    await setVal('.js-slip-review input[aria-label="Time on the slip"]', SLIP_TIME);
  };
  await goto(desk, "/upsell-cash");
  await desk.waitForSelector(".js-confirm");
  await desk.click(".js-confirm");
  await desk.waitForSelector(".js-slips-dialog");
  await fill(owed / 100 - 50);
  const saveOff = await desk.$eval(".js-slip-save", (b) => b.disabled);
  check("the Admin must tick that the slip's recipient is the company account before saving", saveOff === true);
  await desk.click(".js-recipient-ok");
  await desk.click(".js-slip-save");
  await desk.waitForSelector(".js-slip-tick", { timeout: 10000 });
  await desk.click(".js-slip-tick");
  const dlg = await text(desk, ".js-slips-dialog");
  const shortOff = await desk.$eval(".js-slips-confirm", (b) => b.disabled);
  check("short by ฿50: shown, and Confirm stays off (return it)", /Short by ฿50/.test(dlg) && shortOff === true, dlg.slice(0, 300));
  const f3 = await fits(desk);
  check("390 px (Admin, checking slips): nothing pushes the page sideways", f3.over <= 0, f3.culprits.join(" "));
  await shot(desk, "admin-slip-short-390");
  await desk.click(".js-slips-dialog .btn.danger");
  await desk.waitForSelector(".js-return-dialog");
  await desk.type("#rt-why", "The slip shows 50 baht less than owed (example)");
  await desk.click(".js-return-dialog .btn.danger");
  await desk.waitForFunction(() => /Returned for checking/.test(document.querySelector(".js-handins")?.textContent ?? ""), { timeout: 10000 });

  await goto(guide, JOB_PATH);
  await guide.waitForSelector(".ups-returned", { timeout: 10000 });
  const back = await text(guide, ".js-handin");
  check("returned: the same ref.โอนเงิน", (await text(guide, ".js-handin .ups-transfer-ref-code")).trim() === memo);
  check("returned: the slip stays, do not transfer again", /do not transfer again/i.test(back) && (await guide.$$(".ups-slip")).length === 1, back.slice(0, 300));
  await tap(guide, ".ups-send");
  await guide.waitForFunction(() => /ส่งแล้ว รอตรวจสอบ/.test(document.querySelector(".js-handin")?.textContent ?? ""), { timeout: 10000 });

  // ── Admin corrects what was recorded (the slip, read again, shows the full amount), ticks, confirms ──
  await goto(desk, "/upsell-cash");
  await desk.click(".js-confirm");
  await desk.waitForSelector(".js-slips-dialog");
  await desk.$$eval(".js-slips-dialog .btn", (bs) => bs.find((b) => /Correct what was recorded/.test(b.textContent ?? ""))?.click());
  await fill(owed / 100);
  await desk.click(".js-recipient-ok");
  await desk.click(".js-slip-save");
  // The first round's (short) review leaves a tick in the dialog, so ".js-slip-tick" alone is
  // already there before this save lands. Wait for the corrected review itself: the shortfall
  // gone and an unticked tick — then tick it and wait for Confirm to come on before pressing it.
  await desk.waitForFunction(() => {
    const d = document.querySelector(".js-slips-dialog");
    const tick = d?.querySelector(".js-slip-tick");
    return !!d && !/Short by/.test(d.textContent ?? "") && !!tick && !tick.checked && !tick.disabled;
  }, { timeout: 10000 });
  const disabledFirst = await desk.$eval(".js-slips-confirm", (b) => b.disabled);
  await desk.click(".js-slip-tick");
  await desk.waitForFunction(() => document.querySelector(".js-slips-confirm")?.disabled === false, { timeout: 10000 });
  await shot(desk, "admin-slip-verified-390");
  await desk.click(".js-slips-confirm");
  await desk.waitForFunction(() => /Confirmed/.test(document.querySelector(".js-handins")?.textContent ?? ""), { timeout: 10000 });
  check("Confirm waits for the reviewed slip to be ticked, then confirms", disabledFirst === true);
  const t = await prisma.cashSettlementTransfer.findFirst();
  check("the transfer carries the Admin's facts from the slip (amount, slip time, ref, account)", t?.amountSatang === owed && t?.bankRef === "KB E2E 7731 0042" && t?.receivingAccountDisplay === "···7890"
    && new Date(t.transferredAt.getTime() + 7 * 3600_000).toISOString().slice(11, 16) === SLIP_TIME, JSON.stringify({ a: t?.amountSatang, r: t?.bankRef }));
  check("confirmed: cash held 0, one remittance", (await held()) === 0 && (await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })) === 1);
  check("the bank clearing is queued and blocked until configured (nothing sent to PEAK)", (await prisma.upsellPeakEvent.count({ where: { eventKind: "BANK_CLEARING", status: "BLOCKED" } })) === 1);
  await goto(desk, "/upsell-cash");
  await desk.waitForSelector(".js-peak-sync");
  const peak = await text(desk, ".js-peak-sync");
  check("the PEAK panel says sending is off and shows the clearing and receipts as Blocked, with the reason", /Automatic sending is off/.test(peak) && /Bank clearing/.test(peak) && /Blocked/.test(peak) && /No PEAK account is mapped/.test(peak), peak.slice(0, 300));
  const f2 = await fits(desk);
  check("390 px (Admin): nothing pushes the page sideways", f2.over <= 0, f2.culprits.join(" "));
  await shot(desk, "admin-390");
  await goto(guide, JOB_PATH);
  check("the guide sees it confirmed and locked", /Confirmed/.test(await text(guide, ".js-handin")) && !(await guide.$(".ups-send")));
  await shot(guide, "guide-confirmed");
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
