// The ☰ column filters on Payments → Guide Payments, in a real browser against a real server
// and database.
//
// Proves: a column's ☰ lists the values on screen; ticking narrows the table to them and the
// button shows how many are ticked; two columns combine; "Clear filters" brings every row back;
// the recorded-payments table filters the same way; nothing on the page errors.
//
// Run after `next build`:  node scripts/e2e/guide-payments-filters.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
//
// All data invented — this repo is public.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
const PORT = Number(process.env.E2E_PORT ?? 3997);
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

// ── data (invented) ──────────────────────────────────────────────────────────
// ── data (invented) ──────────────────────────────────────────────────────────
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const DAY = (n) => `${TODAY.slice(0, 8)}${String(n).padStart(2, "0")}`;
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const GUIDES = [["G-961", "Nok Example"], ["G-962", "Ploy Example"]];
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentTransfer", "GuidePaymentSupplementLine", "SupplementalPayment", "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument",
    "PaymentEvidence", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  await prisma.tour.create({ data: { id: "T-901", name: "Night Market Walk", time: "18:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op-f@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  for (const [g, name] of GUIDES) await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: name, fullName: name, guideId: g, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  // Six jobs this month: three per guide, on two tours; two approved per guide.
  let n = 0;
  for (const [g] of GUIDES) for (const [i, tour] of [["T-900", 0], ["T-901", 1], ["T-900", 2]].map(([t], i) => [i, t])) {
    n++;
    const date = DAY(1 + (n % 1));
    await prisma.assignment.create({ data: { guideId: g, date, slotIdx: i, tourId: tour, pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-F-${String(n).padStart(2, "0")}`, guideId: g, date, slotIdx: i, tourId: tour, status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [],
      ...(i < 2 ? { approvalStatus: "APPROVED" } : {}) } });
  }
  // Recorded payments: one per guide, one of them reversed.
  for (const [k, [g]] of GUIDES.entries()) {
    await prisma.guidePayment.create({ data: { paymentNo: `FOLK-PMT-209901-00${k + 1}`, guideId: g, accountingPeriod: TODAY.slice(0, 7), paymentDate: DAY(1), jobTotal: 500, adjustmentTotal: 0, amountTransferred: 500,
      status: k ? "REVERSED" : "RECORDED", source: "MANUAL", noSlipReason: "cash (example)", createdById: op.id, ...(k ? { reversedAt: new Date(), reversalReason: "entered twice (example)" } : {}) } });
  }
}

async function startServer(extraEnv = {}) {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", FAKE_DRIVE_LOG: DRIVE_LOG, PEAK_ADVANCE_CONFIG: PEAK_CONFIG, ADVANCE_WRITES_FROZEN: "", PEAK_ADVANCE_AUTO_SYNC: "", ADVANCE_EXISTING_PEAK_LINKS_ENABLED: "1", ...extraEnv },
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


// ── the test ─────────────────────────────────────────────────────────────────
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cand = (page) => page.$$eval("table.pay-cand tbody tr", (trs) => trs.map((t) => t.innerText).filter((t) => /FOLK-TEST-F-/.test(t)));
const pays = (page) => page.$$eval("table.acct-table:not(.pay-cand) tbody tr", (trs) => trs.map((t) => t.innerText).filter((t) => /FOLK-PMT-/.test(t)));
async function openFilter(page, table, label) {
  await page.evaluate((table, label) => document.querySelector(`${table} thead button[aria-label="Filter ${label}"]`).click(), table, label);
  await page.waitForSelector(".colf-pop", { timeout: 5000 });
}
const items = (page) => page.$$eval(".colf-pop .colf-item", (xs) => xs.map((x) => ({ v: x.innerText.trim(), on: x.querySelector("input").checked })));
async function tick(page, value) { await page.evaluate((v) => [...document.querySelectorAll(".colf-pop .colf-item")].find((x) => x.innerText.trim() === v).querySelector("input").click(), value); await pause(200); }
async function only(page, value) { await page.evaluate(() => [...document.querySelectorAll(".colf-pop .colf-actions button")].find((b) => b.innerText === "None").click()); await pause(150); await tick(page, value); }
async function closePop(page) { await page.keyboard.press("Escape"); await pause(150); }

await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCookie(await sessionCookie("op-f@example.test"));
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await page.evaluate(() => [...document.querySelectorAll("button.subtab")].find((b) => b.innerText.trim() === "Guide Payments").click());
  await page.waitForFunction(() => document.querySelectorAll("table.pay-cand tbody tr").length >= 6, { timeout: 20000 });
  check("all six jobs are listed before filtering", (await cand(page)).length === 6);

  await openFilter(page, "table.pay-cand", "Guide");
  const g = await items(page);
  check("the Guide ☰ lists each guide on screen, all ticked", JSON.stringify(g) === JSON.stringify([{ v: "G-961 Nok Example", on: true }, { v: "G-962 Ploy Example", on: true }]), JSON.stringify(g));
  await only(page, "G-962 Ploy Example");
  await closePop(page);
  let rows = await cand(page);
  check("ticking one guide shows only their three jobs", rows.length === 3 && rows.every((t) => /G-962/.test(t)), String(rows.length));
  const flag = await page.$eval('table.pay-cand thead button[aria-label="Filter Guide"]', (b) => ({ on: b.classList.contains("on"), n: b.querySelector("b")?.textContent }));
  check("the ☰ shows it is filtered", flag.on && flag.n === "1", JSON.stringify(flag));

  await openFilter(page, "table.pay-cand", "Tour");
  await only(page, "Night Market Walk");
  await closePop(page);
  rows = await cand(page);
  check("a second column combines with the first", rows.length === 1 && /G-962/.test(rows[0]) && /Night Market Walk/.test(rows[0]), String(rows.length));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-payments-filters.png"), fullPage: true });

  await openFilter(page, "table.pay-cand", "Readiness");
  const r = await items(page);
  check("Readiness lists Approved and Not approved", r.map((x) => x.v).join() === "Approved,Not approved", JSON.stringify(r));
  await closePop(page);

  await page.$eval(".js-clear-cand-filters", (b) => b.click());
  await pause(300);
  check("Clear filters brings every job back", (await cand(page)).length === 6);

  await openFilter(page, "table.acct-table:not(.pay-cand)", "Status");
  await only(page, "Reversed");
  await closePop(page);
  const p = await pays(page);
  check("recorded payments filter by status", p.length === 1 && /FOLK-PMT-209901-002/.test(p[0]), JSON.stringify(p));
  await page.$eval(".js-clear-pay-filters", (b) => b.click());
  await pause(300);
  check("and clear back to both", (await pays(page)).length === 2);

  // A phone: the list opens inside the screen.
  await page.setViewport({ width: 390, height: 844 });
  await pause(300);
  await openFilter(page, "table.pay-cand", "Payment");
  const box = await page.$eval(".colf-pop", (x) => { const r = x.getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
  check("on a phone the list stays on screen", box.l >= 0 && box.r <= box.w, JSON.stringify(box));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-payments-filters-phone.png") });
  await closePop(page);
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
