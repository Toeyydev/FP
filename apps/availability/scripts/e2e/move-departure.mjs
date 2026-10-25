// Move departure (ย้ายรอบ) on the job sheet page, in a real browser against a real server
// and database.
//
// Proves, on the page:
//   1. the More menu offers ย้ายรอบ; the dialog lists the sheet's guests, all ticked
//   2. "อื่นๆ" cannot be sent without a written reason
//   3. moving one guest (แขกไม่สบาย, same guide): the booking moves and is pinned, the guide
//      has the job at the new time, the guest leaves this sheet and the note says why
//   4. the done view offers a WhatsApp message with the new date — nothing is sent
//   5. at phone width (390px) the dialog fits without sideways scroll
//
// Run after `next build`:  node scripts/e2e/move-departure.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET. Screenshots go to E2E_SCREEN_DIR if set.
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
const G = "G-985";
const bkkDay = (n) => new Date(Date.now() + 7 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const DATE = bkkDay(0);
const TO = bkkDay(1);
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } };
async function seed() {
  const tables = ["AuditLog", "Notification", "TourPayment", "JobSheet", "Booking", "Assignment", "JobOffer", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.blockedDate.deleteMany({});
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.user.create({ data: { email: "g985@example.test", displayName: "Pim Example", fullName: "Pim Example", guideId: G, role: "GUIDE", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 4 } });
  for (const [ref, name, phone] of [["GYG-E2E-1", "Anna Example", "+393331110001"], ["GYG-E2E-2", "Ben Example", "+393331110002"]]) {
    await prisma.booking.create({ data: { source: "GETYOURGUIDE", externalId: ref, externalRef: ref, tourId: "T-900", date: DATE, slotIdx: 0, pax: 2, status: "ASSIGNED", customerName: name, phone } });
  }
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-MV-E2E", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
    bookings: [{ name: "Anna Example", bookingNo: "GYG-E2E-1", bookedPax: 2, actualPax: null, tickets: "", status: "" }, { name: "Ben Example", bookingNo: "GYG-E2E-2", bookedPax: 2, actualPax: null, tickets: "", status: "" }],
    expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 } } });
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
const setValue = (page, selector, value) => page.evaluate((selector, value) => {
  const el = document.querySelector(selector);
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}, selector, value);
const dialogText = (page) => page.$eval(".js-move-departure", (x) => x.innerText);

// ── the test ─────────────────────────────────────────────────────────────────
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1400 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setCookie(await sessionCookie(data.op.email));
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-bar", { timeout: 20000 });

  // 1
  await page.click(".js-more-btn");
  await page.click(".js-move-open");
  await page.waitForSelector(".js-move-departure");
  const ticked = await page.$$eval('.js-move-departure input[type="checkbox"]', (xs) => xs.map((x) => x.checked));
  check("1 · ย้ายรอบ opens with both guests ticked", JSON.stringify(ticked) === "[true,true]", JSON.stringify(ticked));

  // 5 — phone width, dialog open
  await page.setViewport({ width: 390, height: 844 });
  await pause(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("5 · at 390px the dialog fits with no sideways scroll", overflow <= 0, `overflow ${overflow}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "move-dialog-phone.png") });
  await page.setViewport({ width: 1200, height: 1400 });
  await pause(200);

  // 2
  await setValue(page, "#move-reason", "other");
  await pause(150);
  check("2 · อื่นๆ with no written reason cannot be sent", await page.$eval(".js-move-submit", (b) => b.disabled));

  // 3 — move Anna only, guest sick, same guide
  await setValue(page, "#move-reason", "guest-sick");
  await page.evaluate(() => [...document.querySelectorAll('.js-move-departure label')].find((l) => l.innerText.includes("GYG-E2E-2")).querySelector("input").click());
  await setValue(page, "#move-date", TO);
  await pause(150);
  if (SHOTS) await (await page.$(".js-move-departure")).screenshot({ path: join(SHOTS, "move-dialog.png") });
  await page.click(".js-move-submit");
  await page.waitForSelector(".js-move-done", { timeout: 20000 });
  const anna = await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-E2E-1" } });
  const ben = await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-E2E-2" } });
  check("3 · Anna moved to the new day and pinned; Ben stays", anna.date === TO && anna.slotIdx === 0 && anna.datePinned && ben.date === DATE, JSON.stringify({ anna: [anna.date, anna.datePinned], ben: ben.date }));
  const newJob = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId: G, date: TO, slotIdx: 0 } } });
  check("3 · the same guide has the job at the new time", !!newJob && newJob.tourId === "T-900");
  const left = await prisma.jobSheet.findUniqueOrThrow({ where: KEY });
  check("3 · Anna left this sheet; the note says where and why", JSON.stringify(left.bookings.map((b) => b.bookingNo)) === '["GYG-E2E-2"]' && /ย้ายรอบ → .* · แขกไม่สบาย · GYG-E2E-1/.test(left.operatorNote ?? ""), `${JSON.stringify(left.bookings.map((b) => b.bookingNo))} | ${left.operatorNote}`);

  // 4
  const wa = await page.$$eval(".js-move-whatsapp", (xs) => xs.map((x) => x.getAttribute("href")));
  check("4 · one WhatsApp link for Anna, carrying the new date", wa.length === 1 && /wa\.me\/393331110001\?text=/.test(wa[0]) && decodeURIComponent(wa[0]).includes("Hello Anna Example"), wa.join(" | ").slice(0, 200));
  check("4 · nothing was sent to the guest", !(await dialogText(page)).includes("sent to"));
  if (SHOTS) await (await page.$(".js-move-departure")).screenshot({ path: join(SHOTS, "move-done.png") });

  await page.click(".js-move-departure .mfoot .btn.primary");
  await page.waitForFunction(() => !document.querySelector(".js-move-departure"), { timeout: 10000 });
  await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
  const listed = await page.evaluate(() => document.body.innerText.includes("GYG-E2E-1"));
  check("3 · after Done the page shows the sheet without Anna", !listed);
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nmove departure e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
