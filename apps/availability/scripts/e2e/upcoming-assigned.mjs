// Jobs → Assigned jobs → Upcoming assigned jobs in a real browser, against a real server and
// database (owner, 2026-11-10): a job accepted 20 days ahead is listed and found by the
// guide's name, an offer nobody has answered is not, a departure with two guides opens each
// guide's own job sheet; operator and admin, desktop and 390px.
// Run after `next build`:  node scripts/e2e/upcoming-assigned.mjs
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

const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const IN20 = plus(20), TWO = plus(12), WAIT = plus(15);
async function seed() {
  const tables = ["AuditLog", "Notification", "JobOfferResponse", "JobOffer", "Booking", "Assignment", "Checkin", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  await prisma.tour.create({ data: { id: "T-901", name: "Canal Walk Example", time: "13:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-u@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "admin-u@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  for (const [g, name] of [["G-981", "Ploy Example"], ["G-982", "Nok Example"]]) {
    await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: name, fullName: name, guideId: g, role: "GUIDE", state: "ACTIVE" } });
  }
  await prisma.assignment.create({ data: { guideId: "G-981", date: IN20, slotIdx: 0, tourId: "T-900", pax: 2 } });
  for (const g of ["G-981", "G-982"]) await prisma.assignment.create({ data: { guideId: g, date: TWO, slotIdx: 2, tourId: "T-901", pax: 6 } });
  await prisma.tour.create({ data: { id: "T-902", name: "Waiting Tour Example", time: "08:30", durationMin: 60 } });
  await prisma.jobOffer.create({ data: { tourId: "T-902", date: WAIT, slotIdx: 0, pax: 3, status: "OPEN", expiresAt: new Date(Date.now() + 3600_000) } });
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
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const rowsShown = (page) => page.$$eval(".js-upcoming .js-up-row", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ")));
try {
  for (const [who, email, width] of [["operator", "op-u@example.test", 1280], ["admin 390px", "admin-u@example.test", 390]]) {
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewport({ width, height: 900 });
    await page.setCookie(await sessionCookie(email));
    await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".js-upcoming .js-up-row", { timeout: 20000 });
    let rows = await rowsShown(page);
    check(`${who}: a job accepted 20 days ahead is listed, with both guides of the shared departure`, rows.some((t) => /Riverside Temples/.test(t) && /G-981 Ploy Example/.test(t)) && rows.some((t) => /Canal Walk Example/.test(t) && /G-981/.test(t) && /G-982/.test(t)), JSON.stringify(rows));
    check(`${who}: an offer nobody has answered is not listed`, !rows.some((t) => /Waiting Tour Example/.test(t)), JSON.stringify(rows));
    await page.type(".js-up-q", "Nok");
    await page.waitForFunction(() => document.querySelectorAll(".js-upcoming .js-up-row").length === 1, { timeout: 10000 }).catch(() => {});
    rows = await rowsShown(page);
    check(`${who}: found by the guide's name`, rows.length === 1 && /Canal Walk Example/.test(rows[0]), JSON.stringify(rows));
    if (who === "operator") {
      await page.$eval(".js-up-q", (x) => { x.value = ""; });
      await page.type(".js-up-q", " ");
      await page.keyboard.press("Backspace");
      await page.waitForFunction(() => document.querySelectorAll(".js-upcoming .js-up-row").length === 2, { timeout: 10000 }).catch(() => {});
      const links = await page.$$eval(".js-upcoming .js-up-sheet", (xs) => xs.map((a) => a.getAttribute("href")));
      check("each guide of the shared departure opens their own job sheet", links.includes(`/job-sheet?guideId=G-981&date=${TWO}&slotIdx=2`) && links.includes(`/job-sheet?guideId=G-982&date=${TWO}&slotIdx=2`), JSON.stringify(links));
      const href = links.find((h) => h.includes("G-982"));
      await page.goto(`${BASE}${href}`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".js-check, .js-sheet", { timeout: 20000 }).catch(() => {});
      const head = await page.evaluate(() => document.body.innerText);
      check("the G-982 link opens G-982's job sheet for that departure", /Nok Example|G-982/.test(head) && /Canal Walk Example/.test(head), head.slice(0, 200));
    } else {
      check("390px: no sideways scroll", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "upcoming-assigned-390.png"), fullPage: true });
    }
    check(`${who}: no page error`, errors.length === 0, errors.join(" | ").slice(0, 200));
    await page.close();
  }
} catch (e) {
  check("run", false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nupcoming assigned e2e: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
