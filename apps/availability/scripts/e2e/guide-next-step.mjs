// The guide's one big button on their job sheet — the next step of the tour day: check in
// → start → check out → file the report. In a real browser against a real server and DB.
//
// Proves: the button names the next step and records it (api/checkin), moving on each
// time; the last step opens the report form on the home screen for this tour; nothing is
// shown for a tour on a later day; the operator never sees it.
//
// Run after `next build`:  node scripts/e2e/guide-next-step.mjs
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
// Yesterday's tour: check-in is long open, whatever the clock says when CI runs.
const DATE = new Date(Date.now() + 7 * 3600 * 1000 - 86400_000).toISOString().slice(0, 10);
const LATER = new Date(Date.now() + 7 * 3600 * 1000 + 3 * 86400_000).toISOString().slice(0, 10);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-961";
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-ns@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g961@example.test", displayName: "Fah Example", fullName: "Fah Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  for (const d of [DATE, LATER]) {
    await prisma.assignment.create({ data: { guideId: G, date: d, slotIdx: 0, tourId: "T-900", pax: 3 } });
    await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-NS-${d.slice(8)}`, guideId: G, date: d, slotIdx: 0, tourId: "T-900", status: "Confirmed",
      bookings: [{ name: "Guest One", bookingNo: "EX-1", bookedPax: 3, actualPax: null, tickets: "", status: "" }], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
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
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
const sheetUrl = (d) => `${BASE}/job-sheet?guideId=${G}&date=${d}&slotIdx=0`;
const button = (page) => page.$eval(".js-next-step", (b) => b.innerText.replace(/\s+/g, " ").trim()).catch(() => null);
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 900 });
  await page.setCookie(await sessionCookie("g961@example.test"));
  await page.goto(sheetUrl(DATE), { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-next-step", { timeout: 20000 });
  for (const [want, type] of [["Check in", "ARRIVE"], ["Start the tour", "START"], ["End the tour · check out", "END"]]) {
    const label = await button(page);
    await page.click(".js-next-step");
    await page.waitForFunction((t) => document.querySelector(".gns")?.dataset.next !== t, { timeout: 20000 }, type).catch(() => {});
    const row = await prisma.checkin.findFirst({ where: { guideId: G, date: DATE, slotIdx: 0, type } });
    check(`"${want}" is the button, and pressing it records ${type}`, (label ?? "").startsWith(want) && !!row, `${label} · recorded=${!!row}`);
  }
  const last = await button(page);
  check("after check-out the button is File the tour report", (last ?? "").startsWith("File the tour report"), last ?? "none");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-next-step.png"), fullPage: false });
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click(".js-next-step")]);
  // (A first-time guide may also get the welcome card — read every open dialog.)
  await page.waitForFunction(() => [...document.querySelectorAll(".modal")].some((m) => /Riverside Temples/.test(m.innerText)), { timeout: 15000 }).catch(() => {});
  const modal = await page.$$eval(".modal", (ms) => ms.map((m) => m.innerText).join(" | ")).catch(() => "");
  check("File the tour report opens the report form on the home screen, for this tour", /Riverside Temples · 3/.test(modal) && !/report=/.test(page.url()), `${page.url()} · ${modal.slice(0, 200)}`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-next-step-report.png"), fullPage: false });

  // A tour on a later day: nothing to press yet.
  await page.goto(sheetUrl(LATER), { waitUntil: "networkidle0" });
  await page.waitForSelector(".guide-sum", { timeout: 20000 });
  check("a tour on a later day shows no button", (await page.$(".js-next-step")) === null);

  // The operator never gets the guide's button.
  const op = await browser.newPage();
  await op.setCookie(await sessionCookie("op-ns@example.test"));
  await op.goto(sheetUrl(DATE), { waitUntil: "networkidle0" });
  await op.waitForSelector(".js-bar", { timeout: 20000 });
  check("the operator's sheet has no guide button", (await op.$(".js-next-step")) === null);
  await op.close();
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
