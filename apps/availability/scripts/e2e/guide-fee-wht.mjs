// A guide fee under ฿1,000 carries no withholding (owner decision 2026-10-25), on the job
// sheet page itself, in a real browser against a real server and database.
//
// Proves, on the page:
//   1. changing the count to 0.5 (a half fee) sets WHT to 0% and locks the rate field
//   2. Save keeps it: the stored fee is 0.5 × ฿1,000 at 0%, and the payout has no tax
//   3. taking the fee back to a full one brings the standard 3% back
//   4. at phone width (390px) the fee table fits without sideways scroll
//
// Run after `next build`:  node scripts/e2e/guide-fee-wht.mjs
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
const PORT = Number(process.env.E2E_PORT ?? 3996);
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
const G = "G-984";
const DATE = "2099-05-12";
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 2 } };
async function seed() {
  const tables = ["AuditLog", "Notification", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.user.create({ data: { email: "g984@example.test", displayName: "Pim Example", fullName: "Pim Example", guideId: G, role: "GUIDE", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-FW-02", guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [],
    guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
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

// ── helpers ──────────────────────────────────────────────────────────────────
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fee = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: KEY })).guideFee;
async function openFee(page) {
  await page.evaluate(() => { const b = document.querySelector(".js-money-line"); if (b && b.getAttribute("aria-expanded") === "false") b.click(); });
  await pause(150);
}
async function typeInto(page, selector, value) {
  const input = await page.$(selector);
  await input.click({ clickCount: 3 });
  await input.type(String(value));
  await pause(200);
}
const wht = (page) => page.$eval(".js-wht-pct", (x) => ({ value: x.value, disabled: x.disabled }));
async function save(page) {
  const ok = await page.evaluate(() => { const b = [...document.querySelectorAll(".js-bar button")].find((x) => x.textContent.trim() === "Save"); if (!b || b.disabled) return false; b.click(); return true; });
  if (!ok) throw new Error('no enabled "Save" button');
  await page.waitForResponse((r) => r.url().endsWith("/api/jobsheet") && r.request().method() === "PUT", { timeout: 15000 });
  await pause(500);
}

// ── the test ─────────────────────────────────────────────────────────────────
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
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=2`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-bar", { timeout: 20000 });
  await openFee(page);
  check("a full ฿1,000 fee starts at 3%, editable", JSON.stringify(await wht(page)) === JSON.stringify({ value: "3", disabled: false }), JSON.stringify(await wht(page)));

  // 1 — a half fee
  await typeInto(page, 'input[title="Number of times/days"]', "0.5");
  const half = await wht(page);
  check("1 · count 0.5 (฿500) sets WHT to 0% and locks the rate", half.value === "0" && half.disabled, JSON.stringify(half));
  const title = await page.$eval(".js-wht-pct", (x) => x.title);
  check("1 · the locked rate says why", /under ฿1,000/.test(title), title);
  if (SHOTS) await (await page.$(".js-pay-table")).screenshot({ path: join(SHOTS, "half-fee.png") });

  // 2 — Save keeps it
  await save(page);
  const stored = await fee();
  check("2 · saved as 0.5 × ฿1,000 at 0%", stored.price === 1000 && stored.time === 0.5 && stored.whtPct === 0, JSON.stringify(stored));

  // 3 — back to a full fee
  await openFee(page);
  await typeInto(page, 'input[title="Number of times/days"]', "1");
  const full = await wht(page);
  check("3 · back to a full fee, the standard 3% returns and the rate is editable", full.value === "3" && !full.disabled, JSON.stringify(full));
  await save(page);
  check("3 · saved as ฿1,000 at 3%", (await fee()).whtPct === 3, JSON.stringify(await fee()));

  // 4 — phone width
  await typeInto(page, 'input[title="Number of times/days"]', "0.5");
  await page.setViewport({ width: 390, height: 844 });
  await pause(300);
  await openFee(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("4 · at 390px the page has no sideways scroll", overflow <= 0, `overflow ${overflow}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "half-fee-phone.png"), fullPage: false });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nguide fee WHT e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
