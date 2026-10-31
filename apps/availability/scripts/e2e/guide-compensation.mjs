// Guide compensation on the job sheet, in a real browser against a real server and database.
//
// Proves, on the page (as an operator):
//   1. a full fee looks as it always did, with the payment type on Full
//   2. 50% Compensation shows standard ฿1,500, payable ฿750, WHT 0, and the transfer ฿750
//   3. Save is refused without a reason, then accepted; the standard fee is still stored
//   4. the PDF shows the standard fee, the payable fee and the reason
//   5. an approved job's fee controls are locked
//   6. at phone width (390px) the page has no sideways scroll
//
// Run after `next build`:  node scripts/e2e/guide-compensation.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET.
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
const PORT = Number(process.env.E2E_PORT ?? 3993);
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
const G = "G-981";
const DATE = "2099-05-16";
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 2 } };
async function seed() {
  const tables = ["AuditLog", "Notification", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "13:30", durationMin: 180 } });
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.user.create({ data: { email: "g981@example.test", displayName: "Jan Example", fullName: "Jan Example", guideId: G, role: "GUIDE", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-GC-02", guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1500, time: 1, whtPct: 3 }, expenses: [] } });
  return { op };
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET: process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789" },
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
const text = (page, sel) => page.$eval(sel, (x) => x.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
async function openFee(page) {
  await page.evaluate(() => { const b = document.querySelector(".js-money-line"); if (b && b.getAttribute("aria-expanded") === "false") b.click(); });
  await pause(200);
}
async function save(page) {
  const ok = await page.evaluate(() => { const b = [...document.querySelectorAll(".js-bar button")].find((x) => x.textContent.trim() === "Save"); if (!b || b.disabled) return false; b.click(); return true; });
  if (!ok) throw new Error('no enabled "Save" button');
  const r = await page.waitForResponse((x) => x.url().endsWith("/api/jobsheet") && x.request().method() === "PUT", { timeout: 15000 });
  await pause(500);
  return r.status();
}
const fee = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: KEY })).guideFee;
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setCookie(await sessionCookie(data.op.email));
  const URL_ = `${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=2`;
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-bar", { timeout: 20000 });
  await openFee(page);

  // 1 — full fee
  check("1 · starts on Full Guide Fee", (await page.$eval(".js-pay-type", (x) => x.value)) === "FULL");
  check("1 · no payable row on a full fee", !(await page.$(".js-fee-payable-row")));

  // 2 — 50%
  await page.select(".js-pay-type", "HALF_COMPENSATION");
  await pause(300);
  const payable = (await text(page, ".js-fee-payable")) ?? "";
  check("2 · payable ฿750", /750\.00/.test(payable), payable);
  const wht = await page.$eval(".js-wht-pct", (x) => ({ value: x.value, disabled: x.disabled }));
  check("2 · WHT 0%, locked", wht.value === "0" && wht.disabled, JSON.stringify(wht));
  const table = (await text(page, ".js-pay-table")) ?? "";
  check("2 · the standard ฿1,500 stays on show", /Standard Guide Fee/.test(table) && /1,500\.00/.test(table), table.slice(0, 200));
  if (SHOTS) await (await page.$(".js-pay-table")).screenshot({ path: join(SHOTS, "compensation.png") });

  // 3 — the reason
  check("3 · Save without a reason is refused", (await save(page)) === 400);
  check("3 · nothing changed", (await fee()).payType === undefined, JSON.stringify(await fee()));
  await page.select(".js-fee-reason", "Attraction / venue closed");
  await page.type(".js-fee-note", "Example venue closed");
  await pause(200);
  check("3 · Save with a reason works", (await save(page)) === 200);
  const stored = await fee();
  check("3 · stored: rate 1,500 × 1, 50%, 0%, the reason", stored.price === 1500 && stored.time === 1 && stored.payType === "HALF_COMPENSATION" && stored.whtPct === 0 && stored.adjustReason === "Attraction / venue closed", JSON.stringify(stored));

  // 4 — the PDF
  const pdf = await page.evaluate(async (g, d) => (await fetch(`/api/jobsheet/pdf?guideId=${g}&date=${d}&slotIdx=2`)).text(), G, DATE);
  check("4 · the job-sheet document shows standard, payable and reason", /Standard Guide Fee/.test(pdf) && /750\.00/.test(pdf) && /Attraction \/ venue closed/.test(pdf));

  // 6 — phone width (before locking, with every control on screen)
  await page.setViewport({ width: 390, height: 844 });
  await pause(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("6 · at 390px the page has no sideways scroll", overflow <= 0, `overflow ${overflow}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "compensation-phone.png"), fullPage: false });
  await page.setViewport({ width: 1200, height: 1600 });

  // 5 — approved
  await prisma.jobSheet.update({ where: KEY, data: { approvalStatus: "APPROVED" } });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-bar", { timeout: 20000 });
  await openFee(page);
  check("5 · an approved job's payment type is locked", await page.$eval(".js-pay-type", (x) => x.disabled));
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nguide compensation e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
