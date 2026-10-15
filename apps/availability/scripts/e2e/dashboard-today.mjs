// The dashboard's Today list — one short line per tour, in a real browser against a real
// server and database.
//
// Proves: each of today's tours is one row (time, tour, guide · pax, one status chip); the
// row is a link to that tour's job sheet; a filed report shows "Reported" with its no-show
// note; the old wide table (job no. / report / expense / pay columns) is gone; on a phone the
// list fits without sideways scrolling; four dots show the steps done; the chips count and
// filter the list.
//
// Run after `next build`:  node scripts/e2e/dashboard-today.mjs
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
const DATE = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // today in Bangkok
const at = (hhmm) => new Date(`${DATE}T${hhmm}:00+07:00`);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-901", name: "Riverside Temples and the Old Town Canals by Long-tail Boat", time: "08:30", durationMin: 180 } });
  await prisma.tour.create({ data: { id: "T-902", name: "Night Market Food Walk", time: "17:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-today@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  for (const [g, name] of [["G-981", "Nok Example"], ["G-982", "Mali Example"], ["G-983", "Ton Example"], ["G-984", "Pim Example"]]) {
    await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: name, fullName: name, guideId: g, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  }
  await prisma.assignment.create({ data: { guideId: "G-981", date: DATE, slotIdx: 0, tourId: "T-901", pax: 4 } });
  await prisma.assignment.create({ data: { guideId: "G-982", date: DATE, slotIdx: 1, tourId: "T-901", pax: 2 } });
  await prisma.assignment.create({ data: { guideId: "G-983", date: DATE, slotIdx: 2, tourId: "T-902", pax: 6 } });
  await prisma.assignment.create({ data: { guideId: "G-984", date: DATE, slotIdx: 3, tourId: "T-902", pax: 3 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-TODAY-01", guideId: "G-981", date: DATE, slotIdx: 0, tourId: "T-901", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
  // Nok: checked in, ran and reported (1 no-show). Mali: checked in only.
  await prisma.checkin.create({ data: { guideId: "G-981", date: DATE, slotIdx: 0, tourId: "T-901", type: "ARRIVE", at: at("08:12") } });
  await prisma.checkin.create({ data: { guideId: "G-981", date: DATE, slotIdx: 0, tourId: "T-901", type: "COMPLETE", at: at("12:40") } });
  await prisma.tourReport.create({ data: { guideId: "G-981", date: DATE, slotIdx: 0, tourId: "T-901", submittedAt: at("12:41"), noShow: 1, completedPax: 3 } });
  await prisma.checkin.create({ data: { guideId: "G-982", date: DATE, slotIdx: 1, tourId: "T-901", type: "ARRIVE", at: at("09:50") } });
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
try {
  for (const [who, width] of [["desktop", 1280], ["phone", 390]]) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewport({ width, height: 900 });
    await page.setCookie(await sessionCookie("op-today@example.test"));
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#today .today-row", { timeout: 20000 });
    const rows = await page.$$eval("#today .today-row", (xs) => xs.map((x) => ({ href: x.getAttribute("href"), text: x.innerText.replace(/\s+/g, " "), h: x.getBoundingClientRect().height })));
    check(`${who}: one row per tour today`, rows.length === 4, String(rows.length));
    check(`${who}: each row links to its job sheet`, rows.every((r) => /^\/job-sheet\?guideId=G-98\d&date=\d{4}-\d\d-\d\d&slotIdx=\d$/.test(r.href)), rows.map((r) => r.href).join(" "));
    check(`${who}: the reported tour says Reported with its no-show`, /Nok Example · 4 pax · 1 no-show/.test(rows[0].text) && /✓ Reported/.test(rows[0].text), rows[0].text);
    check(`${who}: the checked-in tour shows its check-in time`, /Checked in 09:50/.test(rows[1].text), rows[1].text);
    const kinds = await page.$$eval("#today .today-row", (xs) => xs.map((x) => [...x.classList].find((c) => c.startsWith("k-"))));
    check(`${who}: reported is done, checked-in is on tour, the rest late or later`, kinds[0] === "k-done" && kinds[1] === "k-live" && kinds.slice(2).every((k) => k === "k-late" || k === "k-later"), kinds.join(","));
    if (who === "desktop") {
      const dots = await page.$$eval("#today .today-row", (xs) => xs.map((x) => x.querySelectorAll(".today-dots i.on").length));
      check("desktop: four dots — the report fills all four, check-in one", dots[0] === 4 && dots[1] === 1 && dots[2] === 0, dots.join(","));
    }
    await page.evaluate(() => [...document.querySelectorAll("#today .today-chip")].find((b) => /^Done/.test(b.textContent)).click());
    await page.waitForFunction(() => document.querySelectorAll("#today .today-row").length === 1, { timeout: 5000 }).catch(() => {});
    const onlyDone = await page.$$eval("#today .today-row", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ")));
    check(`${who}: the Done chip filters to the reported tour`, onlyDone.length === 1 && /Nok Example/.test(onlyDone[0]), onlyDone.join(" | "));
    await page.evaluate(() => [...document.querySelectorAll("#today .today-chip")].find((b) => /^All/.test(b.textContent)).click());
    await page.waitForFunction(() => document.querySelectorAll("#today .today-row").length === 4, { timeout: 5000 }).catch(() => {});
    check(`${who}: rows are one short line each`, rows.every((r) => r.h <= 52), rows.map((r) => Math.round(r.h)).join(","));
    check(`${who}: the wide table is gone`, (await page.$("#today table")) === null);
    const sideways = await page.$eval("#today", (x) => x.scrollWidth - x.clientWidth);
    const pageWide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const chipsIn = await page.$$eval("#today .today-row .today-ck", (xs) => xs.every((x) => x.getBoundingClientRect().right <= window.innerWidth));
    check(`${who}: no sideways scrolling, every status chip on screen`, sideways <= 1 && pageWide <= 1 && chipsIn, `${sideways}/${pageWide}/${chipsIn}`);
    if (SHOTS) { await page.$eval("#today", (x) => x.scrollIntoView()); await page.screenshot({ path: join(SHOTS, `today-${who}.png`) }); }
    await page.close();
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("ran without throwing", false, String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
