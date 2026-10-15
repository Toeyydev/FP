// Check-out on the guide's own app page — in a real browser against a real server and
// database, with the browser's location set.
//
// Proves: after "Start tour" the guide's button is "Check out"; pressing it stores an END
// check-in with the guide's position; the button then becomes "File the tour report"; the
// job sheet's timeline shows the check-out with its time and location.
//
// Run after `next build`:  node scripts/e2e/checkout.mjs
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
const SLOT_TIMES = ["08:30", "10:00", "13:30", "14:00", "15:00", "16:30", "17:30", "18:30"];
const bkk = new Date(Date.now() + 7 * 3600 * 1000);
const TODAY = bkk.toISOString().slice(0, 10);
const nowMin = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
// The latest departure today whose check-in window (45 min before) has opened.
const SLOT = SLOT_TIMES.map((t, i) => [i, Number(t.slice(0, 2)) * 60 + Number(t.slice(3))]).filter(([, m]) => m - 45 <= nowMin).map(([i]) => i).pop();
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-987";
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: SLOT_TIMES[SLOT ?? 0], durationMin: 180, meetingLat: 13.75, meetingLng: 100.49, meetingRadiusM: 150 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "g987@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT ?? 0, tourId: "T-900", pax: 2 } });
  await prisma.checkin.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT ?? 0, tourId: "T-900", type: "ARRIVE" } });
  await prisma.checkin.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT ?? 0, tourId: "T-900", type: "START" } });
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
if (SLOT === undefined) {
  // Before 07:45 Bangkok no departure's check-in window is open yet; nothing to drive.
  check("skipped — no check-in window open this early (Bangkok)", true);
  console.log("\n1 passed, 0 failed");
  process.exit(0);
}
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
const buttons = (page) => page.$$eval("button", (bs) => bs.map((b) => b.innerText.trim()));
try {
  await browser.defaultBrowserContext().overridePermissions(BASE, ["geolocation"]);
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation({ latitude: 13.7712, longitude: 100.4905, accuracy: 15 });
  await page.setCookie(await sessionCookie("g987@example.test"));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Check out"), { timeout: 20000 });
  check("after the start, the guide's next step is Check out", (await buttons(page)).includes("Check out"));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Check out").click());
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "File the tour report"), { timeout: 20000 });
  const end = await prisma.checkin.findFirst({ where: { type: "END" } });
  check("check-out is stored with the guide's position and how far from the meeting point", !!end && Math.abs(end.lat - 13.7712) < 1e-6 && end.withinGeofence === false && end.distanceM > 2000 && end.recordedByRole === null, JSON.stringify(end && { lat: end.lat, d: end.distanceM, w: end.withinGeofence }));
  check("then the button is File the tour report — check-out did not finish the job", (await buttons(page)).includes("File the tour report") && (await prisma.checkin.count({ where: { type: "COMPLETE" } })) === 0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "checkout-guide-home.png") });
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${TODAY}&slotIdx=${SLOT}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-tour-day", { timeout: 20000 });
  const co = await page.$eval('.js-tour-day [data-step="CHECK_OUT"]', (x) => x.innerText.replace(/\s+/g, " "));
  check("the job sheet timeline shows the check-out with its time and location", /Away from the meeting point · 2\.4 km/.test(co) && /\d\d:\d\d/.test(co) && !/Recorded with the report/.test(co), co);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "checkout-timeline.png") });
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
