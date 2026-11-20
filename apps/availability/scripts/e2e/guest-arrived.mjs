// "มาแล้ว" in a real browser, against a real server and database: the office ticks a guest
// on the sheet and sees the time and the count on Jobs; a guide who checked in ticks their
// own guest at 390px. Run after `next build`:  node scripts/e2e/guest-arrived.mjs
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
const PORT = Number(process.env.E2E_PORT ?? 3991);
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
// ── data ─────────────────────────────────────────────────────────────────────
async function seed() {
  const tables = ["AuditLog", "Notification", "Booking", "Assignment", "Checkin", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const guide = await prisma.user.create({ data: { email: "g901@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: "G-901", role: "GUIDE", state: "ACTIVE", passwordHash: hash, consentAt: new Date(), claimedAt: new Date() } });
  for (const [date, ref, name] of [[TODAY, "E2E-AR-1", "Guest Today"], [TOMORROW, "E2E-AR-2", "Guest Tomorrow"]]) {
    await prisma.assignment.create({ data: { guideId: "G-901", date, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.booking.create({ data: { source: "manual", tourId: "T-900", date, slotIdx: 0, pax: 2, customerName: name, externalRef: ref, confirmationCode: ref, status: "ASSIGNED" } });
  }
  // The guide has checked in for tomorrow's departure (the tick opens at check-in).
  await prisma.checkin.create({ data: { guideId: "G-901", date: TOMORROW, slotIdx: 0, tourId: "T-900", type: "ARRIVE" } });
  return { op, guide };
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
const sheetUrl = (date) => `${BASE}/job-sheet?guideId=G-901&date=${date}&slotIdx=0`;
const hhmm = /\b\d{2}:\d{2}\b/;
try {
  // The office ticks today's guest in the sheet table.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.op.email));
    await page.goto(sheetUrl(TODAY), { waitUntil: "networkidle0" });
    await page.waitForSelector("table.js-table label.js-arrived input", { timeout: 20000 });
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/jobsheet/arrived") && r.ok(), { timeout: 15000 }), page.click("table.js-table label.js-arrived input")]);
    await page.waitForFunction(() => /\d{2}:\d{2}/.test(document.querySelector("table.js-table label.js-arrived")?.textContent ?? ""), { timeout: 10000 });
    const b = await prisma.booking.findFirst({ where: { externalRef: "E2E-AR-1" } });
    check("office: the tick saves the time on the booking", !!b?.arrivedAt);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("table.js-table label.js-arrived input", { timeout: 20000 });
    const kept = await page.$eval("table.js-table label.js-arrived", (l) => ({ on: l.querySelector("input").checked, t: l.textContent }));
    check("office: after reload the tick and its time are still there", kept.on && hhmm.test(kept.t), JSON.stringify(kept));
    await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".js-arrived-count", { timeout: 20000 });
    const count = await page.$eval(".js-arrived-count", (x) => x.textContent);
    check("Jobs: today's job shows มาแล้ว 2/2", count.includes("มาแล้ว 2/2"), count);
    check("office: no page error", errors.length === 0, errors.join(" | ").slice(0, 200));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "guest-arrived-jobs.png") });
    await page.close();
  }
  // The guide ticks their own guest on a phone.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.guide.email));
    await page.goto(sheetUrl(TOMORROW), { waitUntil: "networkidle0" });
    await page.waitForSelector(".gs-cust label.js-arrived input:not([disabled])", { timeout: 20000 });
    const before = await page.$eval(".js-arrived-count", (x) => x.textContent);
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/jobsheet/arrived") && r.ok(), { timeout: 15000 }), page.click(".gs-cust label.js-arrived input")]);
    await page.waitForFunction(() => /\d{2}:\d{2}/.test(document.querySelector(".gs-cust label.js-arrived")?.textContent ?? ""), { timeout: 10000 });
    const after = await page.$eval(".js-arrived-count", (x) => x.textContent);
    check("guide 390px: count goes 0/2 → 2/2 with the time beside the guest", before.includes("0/2") && after.includes("2/2"), `${before} → ${after}`);
    const b = await prisma.booking.findFirst({ where: { externalRef: "E2E-AR-2" } });
    check("guide 390px: saved on the booking", !!b?.arrivedAt);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    check("guide 390px: no sideways scroll", fits);
    check("guide 390px: no page error", errors.length === 0, errors.join(" | ").slice(0, 200));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "guest-arrived-guide-390.png"), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nguest arrived e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
