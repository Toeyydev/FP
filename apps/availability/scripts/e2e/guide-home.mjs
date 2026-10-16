// The guide's Home on a phone — simpler (owner 2026-10-16). In a real browser against a
// real server and database.
//
// Proves: name and date on one line; one Next card with the one next-step button (no second
// Check in in the list); what the guide still has to do — expenses to report, their details,
// alerts — as one To do list instead of separate banners; My tours one line each, opening
// the job sheet, Cancel still there; no legend at the bottom; the page fits 390 px.
//
// Run after `next build`:  node scripts/e2e/guide-home.mjs
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
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-941";
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples and the Old Town Canals by Long-tail Boat", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  // A guide whose details are not complete yet (no bank, no emergency contact).
  await prisma.user.create({ data: { email: "g941@example.test", displayName: "Ploy Example", fullName: "Ploy Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  for (const [d, slot] of [[day(-2), 0], [day(1), 0], [day(3), 2]]) {
    await prisma.assignment.create({ data: { guideId: G, date: d, slotIdx: slot, tourId: "T-900", pax: 3 } });
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
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844 });
  await page.setCookie(await sessionCookie("g941@example.test"));
  // The first-visit welcome card is not what this test is about.
  await page.evaluateOnNewDocument(() => { try { for (const k of Object.keys(localStorage)) localStorage.removeItem(k); } catch {} });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".gh-slim", { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => /Got it|เข้าใจแล้ว/.test(b.innerText))?.click());
  await new Promise((r) => setTimeout(r, 300));

  const hero = await page.$eval(".gh-slim", (x) => ({ text: x.innerText.replace(/\s+/g, " "), h: x.getBoundingClientRect().height }));
  check("name and date on one short line", /Ploy/.test(hero.text) && hero.h < 60, JSON.stringify(hero));
  const todo = await page.$$eval(".todo-card .todo-row", (xs) => xs.map((x) => x.className.split(" ").find((c) => c.startsWith("js-todo-"))));
  check("To do lists the expenses to report and the details to finish, one line each", todo.includes("js-todo-expenses") && todo.includes("js-todo-profile"), JSON.stringify(todo));
  check("…instead of the separate banners", (await page.$(".setup-card, .profile-gate")) === null);
  const rows = await page.$$eval(".sched-row", (xs) => xs.map((x) => ({ href: x.querySelector("a.sched-link")?.getAttribute("href") ?? "", h: x.getBoundingClientRect().height, cancel: !!x.querySelector(".sched-cancel"), buttons: [...x.querySelectorAll("button")].map((b) => b.innerText.trim()) })));
  check("My tours: one short line per tour, each opening its job sheet", rows.length >= 2 && rows.every((r) => /^\/job-sheet\?guideId=G-941&date=\d{4}-\d\d-\d\d&slotIdx=\d$/.test(r.href) && r.h <= 64), JSON.stringify(rows.map((r) => [r.href.slice(-24), Math.round(r.h)])));
  check("…with Cancel still there, and no second Check in in the list", rows.every((r) => r.cancel && !r.buttons.some((b) => /Check in|เช็คอิน/.test(b))), JSON.stringify(rows.map((r) => r.buttons)));
  check("no legend at the bottom of Home", (await page.$(".footnote")) === null);
  const fit = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).position !== "fixed"; }).length);
  check("Home fits a phone", fit === 0, String(fit));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-home.png"), fullPage: true });

  // The banners are still on the other views, where they were.
  await page.goto(`${BASE}/?view=week`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".profile-gate", { timeout: 20000 }).catch(() => {});
  check("the Week view still shows the details banner", (await page.$(".profile-gate")) !== null);
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
