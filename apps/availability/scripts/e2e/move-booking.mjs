// Moving a booking to another date / time from "Record who guided", in a real browser against
// a real server and database.
//
// Proves: a departure that has guests and no guide offers "Move…"; the form suggests the next
// morning; confirming moves the booking there, pinned against the channel sync, audited with
// where it was; the dialog says where it went; and the day stops asking for a guide.
//
// Run after `next build`:  node scripts/e2e/move-booking.mjs
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
const day = (n) => new Date(Date.now() + 7 * 3600 * 1000 + n * 86400_000).toISOString().slice(0, 10);
const YESTERDAY = day(-1), TODAY = day(0), TOMORROW = day(1);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
async function seed() {
  const tables = ["AuditLog", "Notification", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "13:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op-mv@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const b = await prisma.booking.create({ data: { source: "Viator.com", externalRef: "E2E-MOVE-1", confirmationCode: "E2E-MOVE-1", customerName: "Guest Example", date: YESTERDAY, slotIdx: 2, tourId: "T-900", pax: 1, status: "PENDING" } });
  // Two days ago, 08:30: three bookings and no guide — two of them were cancelled by the guest.
  const mk = (ref, pax) => prisma.booking.create({ data: { source: "Example OTA", externalRef: ref, confirmationCode: ref, customerName: `Guest ${ref}`, date: day(-2), slotIdx: 0, tourId: "T-900", pax, status: "PENDING" } });
  const cxl = [await mk("E2E-CXL-1", 2), await mk("E2E-CXL-2", 1), await mk("E2E-KEEP-1", 4)];
  return { op, b, cxl };
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
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844 });
  await page.setCookie(await sessionCookie("op-mv@example.test"));
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".att-past", { timeout: 20000 });
  await page.$eval(".att-past", (b) => b.click());
  await page.waitForSelector(".js-move-open", { timeout: 15000 });
  check("a departure with guests and no guide offers Move…", true);
  await page.$eval(".js-move-open", (b) => b.click());
  await page.waitForSelector(".js-move-form");
  const suggested = await page.$eval(".js-move-form", (f) => ({ date: f.querySelector('[name="move-date"]').value, slot: f.querySelector('[name="move-slot"]').selectedOptions[0].innerText }));
  check("the form suggests the next morning", suggested.date === TODAY && suggested.slot === "08:30", JSON.stringify(suggested));
  await page.evaluate((v) => {
    const el = document.querySelector('.js-move-form [name="move-date"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, TOMORROW);
  await pause(300);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "move-booking-form.png") });
  await page.$eval(".js-move-confirm", (b) => b.click());
  await page.waitForFunction(() => /Moved 1 booking/i.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 20000 });
  const after = await prisma.booking.findUniqueOrThrow({ where: { id: data.b.id } });
  check("the booking is on tomorrow 08:30, pinned, still waiting for a guide there", after.date === TOMORROW && after.slotIdx === 0 && after.datePinned === true && after.status === "PENDING", JSON.stringify({ d: after.date, s: after.slotIdx, p: after.datePinned, st: after.status }));
  const a = await prisma.auditLog.findFirst({ where: { action: "booking.moved" } });
  check("the move is audited with where it was", a?.actorId === data.op.id && a?.detail?.from?.date === YESTERDAY && a?.detail?.from?.slotIdx === 2 && a?.detail?.to?.date === TOMORROW);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "move-booking-done.png") });
  await page.evaluate(() => [...document.querySelectorAll(".modal .mfoot button")].find((b) => /Done|Close/.test(b.innerText)).click());
  await pause(1500);
  check("yesterday no longer asks for a guide", (await page.$$(".att-past")).length === 1);

  // Cancelled…: two of three bookings on a departure were cancelled by the guest.
  await page.waitForSelector(".att-past", { timeout: 20000 });
  await page.$eval(".att-past", (b) => b.click());
  await page.waitForSelector(".js-cancel-open", { timeout: 15000 });
  await page.$eval(".js-cancel-open", (b) => b.click());
  await page.waitForSelector(".js-cancel-form");
  check("Cancelled… lists the departure's bookings, none ticked, and cannot be confirmed empty",
    (await page.$$eval(".js-cancel-form input[type=checkbox]", (xs) => xs.map((x) => x.checked).join())) === "false,false,false" && (await page.$eval(".js-cancel-confirm", (b) => b.disabled)));
  await page.evaluate(() => { const boxes = [...document.querySelectorAll(".js-cancel-form label")]; for (const l of boxes) if (/E2E-CXL-/i.test(l.innerText)) l.querySelector("input").click(); });
  await pause(300);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "cancel-bookings-form.png") });
  await page.$eval(".js-cancel-confirm", (b) => b.click());
  await page.waitForFunction(() => /2 bookings marked cancelled/i.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 20000 });
  const st = await prisma.booking.findMany({ where: { id: { in: data.cxl.map((x) => x.id) } }, orderBy: { externalRef: "asc" }, select: { externalRef: true, status: true } });
  check("the ticked bookings are Cancelled; the other is untouched", JSON.stringify(st.map((x) => x.status)) === JSON.stringify(["CANCELLED", "CANCELLED", "PENDING"]), JSON.stringify(st));
  const left = await page.$eval(".recpast-slot", (x) => x.innerText.replace(/\s+/g, " "));
  check("the departure now shows only the booking that stays, and still asks who guided", /E2E-KEEP-1/i.test(left) && !/E2E-CXL/i.test(left) && /4 pax/.test(left) && !!(await page.$('select[aria-label="Guide for 08:30"]')), left.slice(0, 160));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "cancel-bookings-done.png") });
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
