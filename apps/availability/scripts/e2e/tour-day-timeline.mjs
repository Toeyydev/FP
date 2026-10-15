// The tour-day timeline on the job sheet — check-in, tour start, check-out, report — seen by
// the guide and by the operator, in a real browser against a real server and database.
//
// Proves: both views show the same four steps with the recorded times (Bangkok), how each
// compares with the scheduled start, where the guide was, and the report's facts; a step an
// operator recorded is marked so; a step not recorded says so.
//
// Run after `next build`:  node scripts/e2e/tour-day-timeline.mjs
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
const at = (hhmm) => new Date(`${DATE}T${hhmm}:00+07:00`);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-986";
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-td@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g986@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 4 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-TD-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
  // 08:12 at the meeting point · 08:35 started (recorded by the operator) · 12:40 checked out · 12:41 report.
  await prisma.checkin.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", type: "ARRIVE", at: at("08:12"), lat: 13.75, lng: 100.49, distanceM: 25, withinGeofence: true } });
  await prisma.checkin.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", type: "START", at: at("08:35"), recordedByRole: "OPERATOR" } });
  await prisma.checkin.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", type: "COMPLETE", at: at("12:40") } });
  await prisma.tourReport.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", submittedAt: at("12:41"), noShow: 1, completedPax: 3 } });
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
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
const read = (page) => page.$$eval(".js-tour-day .tday-step", (xs) => xs.map((x) => ({ step: x.dataset.step, done: x.classList.contains("done"), time: x.querySelector(".js-tday-time")?.innerText ?? null, text: x.innerText.replace(/\s+/g, " ") })));
try {
  for (const [who, email, width] of [["operator", "op-td@example.test", 1280], ["guide", "g986@example.test", 390]]) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(`${who}: ${String(e)}`));
    await page.setViewport({ width, height: 900 });
    await page.setCookie(await sessionCookie(email));
    await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".js-tour-day", { timeout: 20000 });
    const s = await read(page);
    check(`${who}: the four steps in order with their times`, JSON.stringify(s.map((x) => [x.step, x.time])) === JSON.stringify([["CHECK_IN", "08:12"], ["TOUR_START", "08:35"], ["CHECK_OUT", "12:40"], ["REPORT", "12:41"]]), JSON.stringify(s.map((x) => [x.step, x.time])));
    check(`${who}: check-in 18 min before start, at the meeting point`, /18 min before start/.test(s[0].text) && /At the meeting point · 25 m/.test(s[0].text), s[0].text);
    check(`${who}: the start recorded by the operator says so`, /5 min after start/.test(s[1].text) && /Recorded by the operator/.test(s[1].text), s[1].text);
    check(`${who}: the report carries its facts`, /3 completed · 1 no-show/.test(s[3].text), s[3].text);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `tour-day-${who}.png`), fullPage: false });
    await page.close();
  }
  // Nothing recorded yet: the steps say so.
  await prisma.checkin.deleteMany({}); await prisma.tourReport.deleteMany({});
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie("g986@example.test"));
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-tour-day", { timeout: 20000 });
  const empty = await read(page);
  check("with nothing recorded every step says Not recorded", empty.every((x) => !x.done && /Not recorded/.test(x.text)) && /0 of 4 recorded/.test(await page.$eval(".tday-sched", (x) => x.innerText)));
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
