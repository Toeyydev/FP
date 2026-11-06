// Today & tomorrow (/today) in a real browser, against a real server and database: an
// operator on a phone sees each departure with its guide, check-in and arrivals, an
// unstaffed departure marked, and the page in the bottom bar. Run after `next build`:
//   node scripts/e2e/tours-today.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates). All data invented — this repo is public.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const PORT = Number(process.env.E2E_PORT ?? 3995);
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

const BKK = (ms) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
const TODAY = BKK(Date.now());
const TOMORROW = BKK(Date.now() + 24 * 3600 * 1000);
async function seed() {
  const tables = ["AuditLog", "Notification", "Booking", "Assignment", "Checkin", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  await prisma.tour.create({ data: { id: "T-901", name: "Old Town Walk", time: "13:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op-t@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g995@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: "G-995", role: "GUIDE", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: "G-995", date: TODAY, slotIdx: 0, tourId: "T-900", pax: 3 } });
  await prisma.booking.create({ data: { source: "manual", tourId: "T-900", date: TODAY, slotIdx: 0, pax: 2, customerName: "Guest A", externalRef: "E2E-TT-1", status: "ASSIGNED", arrivedAt: new Date() } });
  await prisma.booking.create({ data: { source: "manual", tourId: "T-900", date: TODAY, slotIdx: 0, pax: 1, customerName: "Guest B", externalRef: "E2E-TT-2", status: "ASSIGNED" } });
  await prisma.checkin.create({ data: { guideId: "G-995", date: TODAY, slotIdx: 0, tourId: "T-900", type: "ARRIVE" } });
  await prisma.booking.create({ data: { source: "manual", tourId: "T-901", date: TOMORROW, slotIdx: 2, pax: 4, customerName: "Guest C", externalRef: "E2E-TT-3", status: "PENDING" } });
  return { op };
}

// ── server ───────────────────────────────────────────────────────────────────
async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    // Attaching to PEAK switched on, so the admin's button is on the page — opening it must still send nothing.
    env: { ...process.env, CERTIFICATE_PEAK_ATTACH: "1", OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET: process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789" },
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.op.email));
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-tours-day", { timeout: 20000 });
  const days = await page.$$eval(".js-tours-day", (s) => s.map((x) => x.innerText.replace(/\s+/g, " ")));
  check("today: the departure with guide, check-in and มาแล้ว 2/3", /วันนี้/.test(days[0]) && /Riverside Temples/.test(days[0]) && /G-995 Nok Example · 3 pax/.test(days[0]) && /เช็คอิน \d{2}:\d{2}/.test(days[0]) && /มาแล้ว 2\/3/.test(days[0]), days[0]);
  check("tomorrow: the departure with no guide is marked", /พรุ่งนี้/.test(days[1]) && /Old Town Walk/.test(days[1]) && /ไม่มีไกด์/.test(days[1]), days[1]);
  const href = await page.$eval(".js-tour-card", (a) => a.getAttribute("href"));
  check("a card opens its job sheet", href === `/job-sheet?guideId=G-995&date=${TODAY}&slotIdx=0`, href);
  const bottom = await page.$$eval(".bottomnav a", (as) => as.map((a) => a.textContent.trim()));
  check("phone: Today is first in the bottom bar", bottom[0] === "Today", JSON.stringify(bottom));
  check("390px: no sideways scroll", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("no page error", errors.length === 0, errors.join(" | ").slice(0, 200));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "tours-today-390.png"), fullPage: true });
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\ntours today e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
