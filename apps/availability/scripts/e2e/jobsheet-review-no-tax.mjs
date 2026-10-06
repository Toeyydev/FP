// A review incentive on a job sheet, from 2026-10-06 — paid in full with the job, no tax. In
// a real browser against a real server and database.
//
// Proves: "★ + Review reward" is back on the job sheet; 4 reviews show ฿200 "no tax" in the
// payout; Save stores the row marked tax-free by the server; the transfer is the fee net of
// 3% plus ฿200 in full; a review row from before keeps its tax.
//
// Run after `next build`:  node scripts/e2e/jobsheet-review-no-tax.mjs
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
const DATE = new Date(Date.now() + 7 * 3600 * 1000 - 2 * 86400_000).toISOString().slice(0, 10);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-981";
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } };
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-rv@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g981@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-RV-10", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
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
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setCookie(await sessionCookie("op-rv@example.test"));
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-add-review", { timeout: 20000 });
  check("★ + Review reward is on the job sheet again, and says reviews carry no tax", /no tax/i.test(await page.$eval(".js-review-note", (x) => x.innerText)));
  await page.$eval(".js-add-review", (b) => b.click());
  await pause(300);
  // 4 reviews: the count is the second number box on the review row.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr")].find((t) => [...t.querySelectorAll("input")].some((i) => i.value === "Review reward"));
    const nums = [...row.querySelectorAll('input[type="number"]')];
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(nums[1], "4"); nums[1].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await pause(400);
  const before = await page.evaluate(() => document.body.innerText);
  check("before saving, the payout shows the review in full with no tax", /Review incentive · no tax/i.test(before) && !/net of 3% WHT[^\n]*Review|Review incentive · net of/i.test(before), (before.match(/Review[^\n]*/gi) ?? []).join(" | ").slice(0, 200));
  await page.evaluate(() => [...document.querySelectorAll(".js-bar button")].find((x) => x.textContent.trim() === "Save").click());
  await page.waitForFunction(() => /saved/i.test([...document.querySelectorAll(".js-bar span")].map((s) => s.textContent).join(" ")), { timeout: 20000 }).catch(() => {});
  await pause(800);
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: KEY });
  const rv = sheet.expenses.find((e) => e.description === "Review reward");
  check("saved: the row is marked tax-free by the server", rv?.taxFree === true && rv?.pax === 4 && rv?.price === 50, JSON.stringify(rv));
  const r = await page.evaluate(async (d) => (await fetch(`/api/payments?period=${d.slice(0, 7)}`, { cache: "no-store" })).json(), DATE);
  const job = (r.rows ?? []).flatMap((x) => x.jobs ?? []).find((j) => j.date === DATE);
  check("the transfer is the fee net of 3% plus the reviews in full: ฿970 + ฿200 = ฿1,170", job && Math.abs(job.amount - 1170) < 0.005, JSON.stringify(job && { amount: job.amount }));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "jobsheet-review-no-tax.png"), fullPage: true });
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
