// PR4-0b in a real browser: Payments > Bank transfers. Read for finance, corrections for an Admin;
// review never hides a real reference; evidence is filed before a correction (Drive is not connected
// here, so the upload is refused and nothing changes); re-record hands off to Record payment with the
// reversed payment's reference fixed. Invented data only.
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
import { tmpdir } from "node:os";
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
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const ADMIN = "admin-bank@example.test", OPS = "ops-bank@example.test";
const GUIDE_ID = "G-991";
const PERIOD = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);

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
let reversedAdvanceId = "", advanceRef = "";
async function seed() {
  const tables = ["AuditLog", "BankTransactionRelease", "BankTransactionUse", "BankTransaction", "GuidePaymentTransfer", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument", "PaymentEvidence", "RefreshToken", "User"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const r = spawnSync(process.execPath, [join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], {
    cwd: appDir, encoding: "utf8", env: { ...process.env, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: PASSWORD },
  });
  check("the deploy seed runs", r.status === 0, r.status === 0 ? "" : (r.stderr || r.stdout).slice(-600));
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: OPS, displayName: "Operator Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g991@example.test", displayName: "Nok Example", guideId: GUIDE_ID, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const pay = (no, bankRef) => prisma.guidePayment.create({ data: { paymentNo: no, guideId: GUIDE_ID, accountingPeriod: PERIOD, paymentDate: `${PERIOD}-02`, jobTotal: 1553, adjustmentTotal: 0, amountTransferred: 1553, bankRef } });
  await pay(`FOLK-PMT-${PERIOD.replace("-", "")}-901`, "KBANK");
  const reversed = await pay(`FOLK-PMT-${PERIOD.replace("-", "")}-902`, "KB-E2E-7731-0001-LONG-REFERENCE-9876543210");
  await prisma.guidePayment.update({ where: { id: reversed.id }, data: { status: "REVERSED", reversedAt: new Date(), reversalReason: "recorded against the wrong job (example)" } });
  // A reversed advance (recorded for the wrong guide) on its own transfer.
  // Unique per run: the reset keeps advances (their registry rows are kept by design).
  const runNo = String(Date.now()).slice(-6);
  advanceRef = `KB-E2E-ADV-${runNo}`;
  const adv = await prisma.guideAdvance.create({ data: { guideId: GUIDE_ID, advanceNo: `ADV-${PERIOD.replace("-", "")}-9${runNo}`, advanceDate: `${PERIOD}-03`, amountSatang: 50000, accountingPeriod: PERIOD,
    purpose: "Ticket advance", allowedCategories: ["entrance"], method: "bank", txRef: advanceRef, date: `${PERIOD}-03`, slotIdx: -1, amount: 500, paidAt: new Date(`${PERIOD}-03T05:00:00.000Z`) } });
  await prisma.guideAdvance.update({ where: { id: adv.id }, data: { reversedAt: new Date(), reversalReason: "recorded for the wrong guide (example)" } });
  reversedAdvanceId = adv.id;
  return reversed;
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      // This throwaway server only: the master switch and the Route Extension's, so the guide
      // can sell. Production keeps every switch off. PEAK, payment link and the rest stay off.
      UPSELL_ENABLED: "", UPSELL_ROUTE_EXTENSION_ENABLED: "", UPSELL_FOOD_TOUR_ENABLED: "", UPSELL_ONSITE_TOUR_ENABLED: "",
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

const goto = async (page, path) => { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30000 }); await new Promise((r) => setTimeout(r, 400)); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `bank-transfers-${name}.png`), fullPage: true }); };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let server, browser;
try {
  const reversed = await seed();
  server = await startServer();
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ── Operator: reads, no buttons ──
  const ops = await browser.newPage();
  await ops.setCookie(await sessionCookie(OPS));
  await ops.setViewport({ width: 1280, height: 900 });
  await goto(ops, "/bank-transfers");
  const list = await text(ops, ".js-bank-transfers");
  check("needs review is listed, with the record and its payee", /KBANK/.test(list) && /FOLK-PMT-\d{6}-901 · G-991/.test(list), list.slice(0, 200));
  await ops.select('select[aria-label="Show"]', "all");
  await pause(800);
  const all = await text(ops, ".js-bank-transfers");
  check("all transfers: the long reference is shown in full and the reversed record is marked", /KB-E2E-7731-0001-LONG-REFERENCE-9876543210/.test(all) && /reversed/.test(all));
  await ops.click(".js-bank-transfers tbody tr");
  await ops.waitForSelector(".js-transfer-dialog");
  check("an Operator sees no correction buttons", !(await ops.$(".js-correct-amount")) && !(await ops.$(".js-mark-reviewed")) && !(await ops.$(".js-rerecord")));
  await ops.setViewport({ width: 390, height: 844 });
  await goto(ops, "/bank-transfers");
  const f = await fits(ops);
  check("390 px: nothing pushes the page sideways", f.over <= 0, f.culprits.join(" "));
  await shot(ops, "list-390");
  await ops.close();

  // ── Admin ──
  const page = await browser.newPage();
  await page.setCookie(await sessionCookie(ADMIN));
  await page.setViewport({ width: 1280, height: 900 });
  await goto(page, "/bank-transfers");
  await page.click(".js-bank-transfers tbody tr");
  await page.waitForSelector(".js-mark-reviewed");
  check("the detail names the company account (here: not recorded)", /Company account\s*not recorded/.test(await text(page, ".js-transfer-dialog")));
  await page.click(".js-mark-reviewed");
  await page.waitForSelector(".js-review-form");
  await page.evaluate(() => [...document.querySelectorAll(".js-review-form label")].find((l) => /A real reference/.test(l.textContent))?.querySelector("input")?.click());
  await pause(200);
  check("a real reference on the slip is sent to the record's own correction — review cannot hide it",
    /Review never changes a reference/.test(await text(page, ".js-review-form")) && !(await page.$(".js-review-form button.primary")));
  await page.evaluate(() => [...document.querySelectorAll(".js-review-form label")].find((l) => /No reference printed/.test(l.textContent))?.querySelector("input")?.click());
  await page.waitForSelector(".js-review-form input[type=file]");
  const slip = join(tmpdir(), "fp-e2e-bank-slip.png");
  writeFileSync(slip, Buffer.from("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFF3F0005FE02FEA7D6A5D20000000049454E44AE426082", "hex"));
  await (await page.$(".js-review-form input[type=file]")).uploadFile(slip);
  await page.type("#bt-rev-note", "slip checked: no reference printed (example)");
  await page.click(".js-review-form button.primary");
  await page.waitForFunction(() => /Google Drive|Google account/.test(document.querySelector(".js-review-form")?.textContent ?? ""), { timeout: 10000 }).catch(() => {});
  check("the refusal is shown to the Admin", /Google Drive|Google account/.test(await text(page, ".js-review-form")));
  const still = await prisma.bankTransaction.findFirst({ where: { refRaw: "KBANK" } });
  check("without evidence on file nothing is cleared (Drive is not connected here)", still?.reviewStatus === "NEEDS_REVIEW", still?.reviewStatus);
  await shot(page, "review");

  // Re-record hand-off
  await goto(page, "/bank-transfers");
  await page.select('select[aria-label="Show"]', "all");
  await pause(800);
  for (const row of await page.$$(".js-bank-transfers tbody tr")) { if (/LONG-REFERENCE/.test(await row.evaluate((e) => e.textContent))) { await row.click(); break; } }
  await page.waitForSelector(".js-rerecord");
  await page.click(".js-rerecord");
  await page.type("#bt-rr-why", "paid for the right job (example)");
  const href = await page.$eval(".js-rerecord-form a.btn", (a) => a.getAttribute("href"));
  check("re-record hands off to Record payment for the reversed payment", !!href && href.includes(`reuse=${reversed.id}`) && href.includes("view=guide-payments"), href ?? "no link");
  await goto(page, href);
  await page.waitForSelector(".js-reuse-banner", { timeout: 15000 }).catch(() => {});
  const banner = await text(page, ".js-reuse-banner");
  check("Record payment opens with the reversed payment named and no new transfer", /FOLK-PMT-\d{6}-902/.test(banner) && /No new bank transfer/.test(banner), banner.slice(0, 160));
  const locked = await page.evaluate(() => [...document.querySelectorAll(".modal input")].find((i) => i.value.includes("LONG-REFERENCE"))?.disabled);
  check("its bank reference is fixed to the reversed one", locked === true);
  await shot(page, "rerecord");

  // Re-record a reversed ADVANCE: hand-off to Record advance, reference fixed
  await goto(page, "/bank-transfers");
  await page.select('select[aria-label="Show"]', "all");
  await pause(800);
  for (const row of await page.$$(".js-bank-transfers tbody tr")) { if ((await row.evaluate((e) => e.textContent)).includes(advanceRef)) { await row.click(); break; } }
  await page.waitForSelector(".js-rerecord");
  await page.click(".js-rerecord");
  await page.type("#bt-rr-why", "the advance was for another guide (example)");
  const advHref = await page.$eval(".js-rerecord-form a.btn", (a) => a.getAttribute("href"));
  check("re-record of a reversed advance hands off to Record advance", !!advHref && advHref.includes(`reuseAdvance=${reversedAdvanceId}`) && advHref.includes("view=advances"), advHref ?? "no link");
  await goto(page, advHref);
  await page.waitForSelector(".js-reuse-banner", { timeout: 15000 }).catch(() => {});
  const advBanner = await text(page, ".js-reuse-banner");
  check("Record advance opens with the reversed advance named and no new transfer", /ADV-\d{6}-9\d{6}/.test(advBanner) && /No new bank transfer/.test(advBanner), advBanner.slice(0, 160));
  const advLocked = await page.evaluate((ref) => [...document.querySelectorAll(".modal input")].find((i) => i.value === ref)?.readOnly, advanceRef);
  check("its bank reference is fixed to the reversed advance's", advLocked === true);
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
