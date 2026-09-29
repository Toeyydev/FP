// The historical evidence page in a real browser, against a real server and database.
//
// Proves, end to end in a real browser: when an operator assigns a guide to a tour
// directly, the guide sees it — an unread badge on the bell and a "You're booked" card
// naming the tour, date and time — without anyone telling them. And a guide cannot
// make an assignment themselves.
//
// Run after `next build`:  node scripts/e2e/direct-assign-notice.mjs
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

// ── data ─────────────────────────────────────────────────────────────────────
const DATE = "2099-04-15";
async function seed() {
  const tables = ["AuditLog", "Notification", "JobOffer", "BlockedDate", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180, meetingPoint: "Pier 1 (example)" } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const guide = await prisma.user.create({ data: { email: "g901@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: "G-901", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  return { op, guide };
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
const assign = (page) => page.evaluate(async (d) => { const r = await fetch("/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: "G-901", date: d, slotIdx: 0, tourId: "T-900", pax: 4, direct: true }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, DATE);
try {
  // A guide cannot assign.
  const gp0 = await browser.newPage();
  await gp0.setCookie(await sessionCookie(data.guide.email));
  await gp0.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  check("a guide cannot make an assignment", (await assign(gp0)).status === 403);
  await gp0.close();

  // The operator assigns directly.
  const op = await browser.newPage();
  await op.setCookie(await sessionCookie(data.op.email));
  await op.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  const r = await assign(op);
  check("the operator's direct assignment succeeds", r.status === 200 && r.body.direct === true, JSON.stringify(r.body));
  await op.close();

  // The guide opens the app on their phone.
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.guide.email));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await pause(1500);
  const badge = await page.$eval("button.iconbtn .navbadge", (b) => b.textContent.trim()).catch(() => "");
  check("the bell shows one unread notice", badge === "1", badge);
  // The bell is the button carrying the unread badge.
  await page.evaluate(() => document.querySelector("button.iconbtn .navbadge")?.closest("button")?.click());
  await page.waitForSelector(".modal .notif-card", { timeout: 10000 });
  const card = await page.$eval(".modal .notif-card", (c) => c.innerText);
  check("the card says the guide is booked, with the tour, date, time and meeting point", /booked, Nok/.test(card) && card.includes("Riverside Temples") && card.includes("Wed 15 Apr") && card.includes("08:30") && card.includes("Pier 1"), card.replace(/\s+/g, " ").slice(0, 200));
  check("the page loads without a crash", errors.length === 0, errors.join(" | ").slice(0, 200));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "direct-assign-notice.png") });
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\ndirect assign notice e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
