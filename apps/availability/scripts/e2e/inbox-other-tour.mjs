// Bookings → Ready to offer, in a real browser against a real server and database: a
// booking whose departure has a guide on ANOTHER tour is not badged "Assigned" — it says no
// guide runs its tour and keeps the offer controls (GYG filed under the wrong tour, 27 Oct
// 2026). A booking of the guide's own tour still shows ✓ Assigned. Fits a 390px phone.
//
// Run after `next build`:  node scripts/e2e/inbox-other-tour.mjs
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
const G = "G-987";
const DAY1 = new Date(Date.now() + 7 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
const DAY2 = new Date(Date.now() + 7 * 3600_000 + 4 * 86400_000).toISOString().slice(0, 10);
async function seed() {
  const tables = ["AuditLog", "Notification", "JobSheet", "Booking", "Assignment", "JobOffer", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  for (const [id, name, time] of [["T-002", "Grand Palace, Wat Pho & Wat Arun (example)", "13:30"], ["T-005", "Wat Phrakaew & Grand Palace (example)", "14:00"]]) {
    await prisma.tour.create({ data: { id, name, time, durationMin: 240 } });
  }
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.user.create({ data: { email: "g987@example.test", displayName: "Mike Example", fullName: "Mike Example", guideId: G, role: "GUIDE", state: "ACTIVE" } });
  // Day 1: Mike runs the combined tour at 13:30; a booking filed under palace-only sits there.
  await prisma.assignment.create({ data: { guideId: G, date: DAY1, slotIdx: 2, tourId: "T-002", pax: 3 } });
  await prisma.booking.create({ data: { source: "GetYourGuide", externalId: "GYG-OT-1", externalRef: "GYG-OT-1", tourId: "T-005", date: DAY1, slotIdx: 2, pax: 1, status: "PENDING", customerName: "Guest One" } });
  // Day 2: Mike runs the same tour as the booking.
  await prisma.assignment.create({ data: { guideId: G, date: DAY2, slotIdx: 2, tourId: "T-002", pax: 1 } });
  await prisma.booking.create({ data: { source: "GetYourGuide", externalId: "GYG-OT-2", externalRef: "GYG-OT-2", tourId: "T-002", date: DAY2, slotIdx: 2, pax: 1, status: "ASSIGNED", customerName: "Guest Two" } });
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cardOf = (page, ref) => page.evaluate((ref) => {
  const chip = [...document.querySelectorAll(".op-toolbar")].find((c) => c.innerText.includes(ref));
  return chip ? chip.innerText : "";
}, ref);

// ── the test ─────────────────────────────────────────────────────────────────
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1400 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.op.email));
  await page.goto(`${BASE}/bookings`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Ready to offer"), { timeout: 20000 });
  // Open every day.
  await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^▸/.test(b.innerText.trim()) && b.querySelector("span")?.style.transform === "none").forEach((b) => b.click()));
  await pause(500);
  const one = await cardOf(page, "GYG-OT-1");
  check("a booking under another tour than the 13:30 guide's is not badged Assigned", !!one && !/Assigned to/i.test(one) && /No guide for this tour · G-987 · Mike Example runs Grand Palace, Wat Pho & Wat Arun \(example\)/i.test(one), one.replace(/\s+/g, " ").slice(0, 240));
  check("…and keeps the offer controls", /Offer all|Offer to guide/i.test(one));
  const two = await cardOf(page, "GYG-OT-2");
  check("a booking of the guide's own tour still shows ✓ Assigned", /Assigned to\s*G-987/i.test(two) && !/No guide for this tour/i.test(two), two.replace(/\s+/g, " ").slice(0, 200));
  if (SHOTS) { const c = await page.$(".js-other-tour"); if (c) await (await c.evaluateHandle((x) => x.closest(".op-toolbar"))).asElement().screenshot({ path: join(SHOTS, "other-tour-card.png") }); }
  await page.setViewport({ width: 390, height: 844 });
  await pause(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("at 390px the page has no sideways scroll", overflow <= 0, `overflow ${overflow}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "other-tour-phone.png"), fullPage: true });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\ninbox other-tour e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
