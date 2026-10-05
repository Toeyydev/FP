// A tour that already ran with two guides, recorded from "Record who guided" — in a real
// browser against a real server and database.
//
// Proves: "+ Add another guide" on a tour with no guide yet records two guides and places
// each booking with one of them; on a tour that already has a guide it adds a colleague and
// keeps the first; each guide has their own job; nobody is notified.
//
// Run after `next build`:  node scripts/e2e/record-shared-guides.mjs
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
const DAY = new Date(Date.now() + 7 * 3600 * 1000 - 3 * 86400_000).toISOString().slice(0, 10);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-sg@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  for (const [g, n] of [["G-971", "Nok Example"], ["G-972", "Ploy Example"], ["G-973", "Mai Example"]]) await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: n, fullName: n, guideId: g, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const mk = (ref, slotIdx, pax, status = "PENDING") => prisma.booking.create({ data: { source: "Example OTA", externalRef: ref, confirmationCode: ref, customerName: `Guest ${ref}`, date: DAY, slotIdx, tourId: "T-900", pax, status } });
  // 08:30: three bookings, no guide. 13:30: one big booking, one guide recorded already.
  const open = [await mk("E2E-SG-1", 0, 4), await mk("E2E-SG-2", 0, 3), await mk("E2E-SG-3", 0, 2)];
  const big = await mk("E2E-SG-BIG", 2, 15, "ASSIGNED");
  await prisma.assignment.create({ data: { guideId: "G-972", date: DAY, slotIdx: 2, tourId: "T-900", pax: 15 } });
  return { open, big };
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
const jobs = async (slotIdx) => (await prisma.assignment.findMany({ where: { date: DAY, slotIdx }, orderBy: { guideId: "asc" } })).map((a) => `${a.guideId}:${a.pax}`).join();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844 });
  await page.setCookie(await sessionCookie("op-sg@example.test"));
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".att-past", { timeout: 20000 });
  await page.$eval(".att-past", (b) => b.click());
  await page.waitForSelector(".js-share-open", { timeout: 15000 });

  // 1 — no guide yet: two guides, the third booking goes with the second.
  await page.$eval(".js-share-open", (b) => b.click());
  await page.waitForSelector(".js-share-form");
  check("the form starts with two guide rows and every booking with Guide 1; it cannot be confirmed before both are chosen",
    (await page.$$(".js-share-form select[aria-label^='Guide '][aria-label$='for 08:30']")).length === 2
    && (await page.$$eval(".js-share-form select[aria-label^='Guide for booking']", (xs) => xs.map((x) => x.value).join())) === "0,0,0"
    && (await page.$eval(".js-share-confirm", (b) => b.disabled)));
  await page.select('select[aria-label="Guide 1 for 08:30"]', "G-971");
  await page.select('select[aria-label="Guide 2 for 08:30"]', "G-972");
  await page.select('select[aria-label="Guide for booking E2E-SG-3"]', "1");
  await pause(300);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "shared-guides-form.png") });
  await page.$eval(".js-share-confirm", (b) => b.click());
  await page.waitForFunction(() => /G-972 · Ploy Example · 2 pax/i.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 20000 });
  check("two jobs: G-971 with 7 guests, G-972 with 2", (await jobs(0)) === "G-971:7,G-972:2", await jobs(0));
  const placed = await prisma.booking.findMany({ where: { id: { in: data.open.map((b) => b.id) } }, orderBy: { externalRef: "asc" }, select: { assignedGuideId: true, status: true } });
  check("each booking is placed with its guide", JSON.stringify(placed.map((b) => `${b.status}:${b.assignedGuideId}`)) === JSON.stringify(["ASSIGNED:G-971", "ASSIGNED:G-971", "ASSIGNED:G-972"]), JSON.stringify(placed));
  check("each guide has a link to their own job sheet", (await page.$$eval(".recpast-slot a", (as) => as.filter((a) => /job-sheet\?guideId=G-97[12]/.test(a.href)).length)) === 2);

  // 2 — one guide already recorded, one big booking: a colleague is added and takes no booking.
  await page.waitForSelector(".js-share-open-staffed", { timeout: 15000 });
  await page.$eval(".js-share-open-staffed", (b) => b.click());
  await page.waitForSelector(".js-staffed-slot .js-share-form");
  check("the guide already recorded is kept and cannot be changed", await page.$eval('select[aria-label="Guide 1 for 13:30"]', (x) => x.value === "G-972" && x.disabled));
  await page.select('select[aria-label="Guide 2 for 13:30"]', "G-973");
  await pause(300);
  await page.$eval(".js-staffed-slot .js-share-confirm", (b) => b.click());
  await page.waitForFunction(() => /13:30 is now shared by G-972 Ploy Example and G-973 Mai Example/i.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 20000 });
  check("the colleague has a job of their own with no booking; the first guide keeps theirs", (await jobs(2)) === "G-972:15,G-973:null", await jobs(2));
  check("the big booking stays with the first guide", (await prisma.booking.findUniqueOrThrow({ where: { id: data.big.id } })).assignedGuideId === "G-972");
  check("nobody was notified", (await prisma.notification.count()) === 0);
  check("both are on record as shared, not notified", (await prisma.auditLog.count({ where: { action: "assign.recorded_past_shared" } })) === 2);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "shared-guides-done.png") });
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
