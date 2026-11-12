// Entrance-ticket badges in a real browser, against a real server and database.
//
// Proves, at phone width (390 px), on the two screens a guide opens (tour details, job sheet):
//   1. a booking whose Rate says tickets are included shows "✓ Included"
//   2. a booking whose Rate says no tickets shows "✕ Not included"
//   3. a Rate that says nothing ("Standard rate") shows no badge at all (owner: Option A)
//   4. a value chosen on the sheet wins over the Rate
//   5. both screens show the same thing, and the page never scrolls sideways
//
// Run after `next build`:  node scripts/e2e/ticket-badge.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET. Screenshots go to E2E_SCREEN_DIR if set.
//
// All data invented — this repo is public.
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
const PORT = Number(process.env.E2E_PORT ?? 3990);
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
const DATE = "2099-03-11";
const EXPECT = { "Incl Rate": "✓ Included", "No Tix Rate": "✕ Not included", "Std Rate": "", "Chosen Not": "✕ Not included" };
async function seed() {
  const tables = ["AuditLog", "Notification", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-901", name: "Old Town Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const users = {};
  users.A = await prisma.user.create({ data: { email: "g-911@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: "G-911", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: "G-911", date: DATE, slotIdx: 0, tourId: "T-901", pax: 8 } });
  const mk = (ref, name, rateTitle) => prisma.booking.create({ data: { source: "Viator.com", externalRef: ref, customerName: name, date: DATE, slotIdx: 0, tourId: "T-901", pax: 2, status: "ASSIGNED", assignedGuideId: "G-911", rateTitle } });
  await mk("VIA-E2E-1", "Incl Rate", "Tour with all entrance tickets");
  await mk("VIA-E2E-2", "No Tix Rate", "Tour without entrance tickets");
  await mk("VIA-E2E-3", "Std Rate", "Standard rate");
  await mk("VIA-E2E-4", "Chosen Not", "Tour with all entrance tickets");
  // The sheet as an operator left it: blank everywhere except one value they chose.
  const rows = [["Incl Rate", "VIA-E2E-1", ""], ["No Tix Rate", "VIA-E2E-2", ""], ["Std Rate", "VIA-E2E-3", ""], ["Chosen Not", "VIA-E2E-4", "not"]]
    .map(([name, bookingNo, tickets]) => ({ name, bookingNo, bookedPax: 2, actualPax: null, tickets, status: "" }));
  const sheet = await prisma.jobSheet.create({ data: { ref: "FOLK-BKK-20990311-01", guideId: "G-911", date: DATE, slotIdx: 0, tourId: "T-901", status: "Confirmed", expenses: [], bookings: rows } });
  return { users, sheet };
}

// ── server ───────────────────────────────────────────────────────────────────
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
// For each guest name on the page, the badge text in the same row / list item ("" for none).
const badges = (page, rowSel) => page.$$eval(rowSel, (rows, names) => {
  const out = {};
  for (const r of rows) {
    const n = names.find((x) => r.textContent.includes(x));
    if (!n) continue;
    out[n] = [...r.querySelectorAll(".js-ticket-badge")].map((b) => b.textContent.trim()).join("|");
  }
  return out;
}, Object.keys(EXPECT));
const seen = {};
try {
  for (const [path, label, rowSel] of [[`/tour-details?date=${DATE}&slotIdx=0`, "tour details", "tbody tr"], [`/job-sheet?guideId=G-911&date=${DATE}&slotIdx=0`, "job sheet", "ol.gs-cust > li"]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.users.A.email));
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
    await pause(1200);
    check(`${label}: loads without a crash`, errors.length === 0, errors.join(" | ").slice(0, 200));
    const got = await badges(page, rowSel);
    seen[label] = got;
    for (const [name, want] of Object.entries(EXPECT)) check(`${label}: ${name} → ${want || "no badge"}`, got[name] === want, JSON.stringify(got[name]));
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${label}: no sideways scroll at 390 px`, wide <= 0, `${wide}px`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `ticket-${label.replace(/ /g, "-")}-390.png`), fullPage: true });
    await page.close();
  }
  check("both screens show the same badges", JSON.stringify(seen["tour details"]) === JSON.stringify(seen["job sheet"]), JSON.stringify(seen));
  const after = await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.sheet.id } });
  check("opening the pages wrote nothing to the job sheet", after.updatedAt.getTime() === data.sheet.updatedAt.getTime());
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nticket badge e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
