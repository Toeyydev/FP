// Tours with no guide recorded, shown on Payments — in a real browser against a real server
// and database.
//
// Proves: a past tour with bookings and no guide is listed on Payments for its month, one
// line per departure with every booking of that date and time together; a departure that has
// a guide is not listed; "Record who guided…" opens that day; once the guide is recorded the
// tour leaves the list and the guide's job appears in Payments.
//
// Run after `next build`:  node scripts/e2e/payments-unstaffed.mjs
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
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
// The first of this month, or — on the 1st itself — today: always this month and not in the future.
const DAY1 = `${TODAY.slice(0, 8)}01`;
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-us@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  for (const [g, n] of [["G-971", "Nok Example"], ["G-972", "Ploy Example"]]) await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: n, fullName: n, guideId: g, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const mk = (ref, slotIdx, pax) => prisma.booking.create({ data: { source: "Example OTA", externalRef: ref, confirmationCode: ref, customerName: `Guest ${ref}`, date: DAY1, slotIdx, tourId: "T-900", pax, status: "PENDING" } });
  // 08:30: two bookings, no guide. 13:30: one booking, a guide already recorded.
  await mk("E2E-US-1", 0, 2); await mk("E2E-US-2", 0, 3); await mk("E2E-US-3", 2, 1);
  await prisma.assignment.create({ data: { guideId: "G-972", date: DAY1, slotIdx: 2, tourId: "T-900", pax: 1 } });
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
  await page.setViewport({ width: 390, height: 844 });
  await page.setCookie(await sessionCookie("op-us@example.test"));
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-unstaffed", { timeout: 20000 });
  const head = await page.$eval(".js-unstaffed summary", (x) => x.innerText.replace(/\s+/g, " "));
  check("Payments says one tour has no guide recorded, with its bookings and guests", /1 tour with no guide recorded/i.test(head) && /2 bookings · 5 guests/.test(head), head);
  const deps = await page.$$eval(".js-unstaffed-dep", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ")));
  check("bookings of the same date and time are one line together; the departure with a guide is not listed",
    deps.length === 1 && /^08:30 Riverside Temples 5 pax/.test(deps[0]) && /E2E-US-1 ×2/i.test(deps[0]) && /E2E-US-2 ×3/i.test(deps[0]) && !/E2E-US-3/i.test(deps[0]), JSON.stringify(deps));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "payments-unstaffed.png"), fullPage: true });

  await page.$eval(".js-unstaffed-record", (b) => b.click());
  await page.waitForSelector("#recpast-h", { timeout: 15000 });
  await page.waitForSelector('select[aria-label="Guide for 08:30"]', { timeout: 15000 });
  check("Record who guided opens on that day and offers Move…", !!(await page.$(".js-move-open")));
  await page.select('select[aria-label="Guide for 08:30"]', "G-971");
  await pause(200);
  await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.innerText.trim() === "Record guide").click());
  await page.waitForFunction(() => /Recorded G-971/i.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll(".modal .mfoot button")].find((b) => /Done|Close/.test(b.innerText)).click());
  await page.waitForFunction(() => !document.querySelector(".js-unstaffed"), { timeout: 20000 });
  check("once the guide is recorded the tour leaves the list", true);
  await pause(800);
  const body = await page.evaluate(() => document.body.innerText);
  check("and the guide's job is now in Payments", /G-971/.test(body) && /Nok Example/.test(body));
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
