// A guide's no-show report shows on the job sheet (owner, 2026-10-27), in a real browser
// against a real server and database.
//
// Proves, on the page:
//   1. the sheet shows what the guide reported — the count and their words — and how many
//      of the no-shows are not yet tied to a booking
//   2. the operator ticks who did not come in the No-show column; it is saved on the
//      booking, and the "not matched" line goes once every no-show is tied to one
//   3. at phone width (390px) the page has no sideways scroll
//
// Run after `next build`:  node scripts/e2e/noshow-report.mjs
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

// ── data ─────────────────────────────────────────────────────────────────────
const G = "G-983";
const DATE = "2099-05-14";
const row = (bookingNo, bookedPax) => ({ name: `Guest ${bookingNo}`, bookingNo, bookedPax, actualPax: bookedPax, tickets: "included", status: "Confirmed" });
async function seed() {
  const tables = ["AuditLog", "Notification", "TourReport", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "13:30", durationMin: 180 } });
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.user.create({ data: { email: "g983@example.test", displayName: "Fern Example", fullName: "Fern Example", guideId: G, role: "GUIDE", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", pax: 5 } });
  for (const [ref, pax] of [["GYG-E2E-NS1", 1], ["GYG-E2E-NS2", 2], ["GYG-E2E-NS3", 2]]) {
    await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, confirmationCode: ref, customerName: `Guest ${ref}`, date: DATE, slotIdx: 2, tourId: "T-900", pax, status: "ASSIGNED" } });
  }
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-NS-02", guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", status: "Review: no-show",
    bookings: [row("GYG-E2E-NS1", 1), row("GYG-E2E-NS2", 2), row("GYG-E2E-NS3", 2)], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
  await prisma.tourReport.create({ data: { guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", bookedPax: 5, noShow: 2, leftEarly: 0, completedPax: 3, comments: "Two guests never came to the meeting point" } });
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
const note = (page) => page.$eval(".js-guide-report", (x) => x.textContent).catch(() => null);
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
  await page.waitForSelector(".js-guide-report", { timeout: 20000 });

  // 1 — what the guide reported
  const first = (await note(page)) ?? "";
  check("1 · the sheet says the guide reported 2 no-show", /Guide reported: 2 no-show/.test(first), first);
  check("1 · with the guide's own words", first.includes("Two guests never came to the meeting point"), first);
  check("1 · and that 2 are not tied to a booking yet", /2 not matched to a booking/.test(first), first);
  if (SHOTS) await (await page.$("#js-guests")).screenshot({ path: join(SHOTS, "noshow-report.png") });

  // 2 — the operator ticks who
  const ticks = await page.$$(".js-ns-tick input");
  check("2 · every booking row has a No-show tick", ticks.length === 3, String(ticks.length));
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/jobsheet/noshow") && r.request().method() === "POST", { timeout: 15000 });
  await ticks[1].click();
  const res = await saved;
  check("2 · the tick is saved", res.ok(), String(res.status()));
  await pause(300);
  const b = await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-E2E-NS2" } });
  check("2 · on the booking: 2 of 2 did not come", b.noShow === true && b.noShowPax === 2, JSON.stringify({ noShow: b.noShow, noShowPax: b.noShowPax }));
  const after = (await note(page)) ?? "";
  check("2 · nothing is left unmatched once the 2 are ticked", !/not matched/.test(after) && /Guide reported: 2 no-show/.test(after), after);

  // 3 — phone width
  await page.setViewport({ width: 390, height: 844 });
  await pause(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("3 · at 390px the page has no sideways scroll", overflow <= 0, `overflow ${overflow}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "noshow-report-phone.png"), fullPage: false });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nno-show report e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
