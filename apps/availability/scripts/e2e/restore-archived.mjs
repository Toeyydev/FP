// "Restore archived bookings" in a real browser, against a real server and database.
//
// Proves:
//   1. an admin reaches it from the menu and the page loads without a crash
//   2. with Bókun not connected, Preview says so — and nothing is restored
//   3. an operator does not see it in the menu, and the endpoint answers 403
//   4. "Archive stale" now leaves a note on each booking it hides, and names them in its audit
//
// Run after `next build`:  node scripts/e2e/restore-archived.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
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
const PORT = Number(process.env.E2E_PORT ?? 3986);
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
async function seed() {
  const tables = ["AuditLog", "Notification", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const users = {};
  for (const [role, email, name] of [["ADMIN", "admin@example.test", "Malee Testsuite"], ["OPERATOR", "op@example.test", "Op Example"]]) {
    users[role] = await prisma.user.create({ data: { email, displayName: name, fullName: name, role, state: "ACTIVE", passwordHash: hash } });
  }
  await prisma.auditLog.create({ data: { action: "bookings.archive_stale", entityType: "Booking", detail: { count: 1, upTo: "2099-06-15" } } });
  const hidden = await prisma.booking.create({ data: { source: "GetYourGuide", externalId: "E2E-1", confirmationCode: "FOLK-TE2E1", externalRef: "GYGE2E1", date: "2020-04-10", slotIdx: 0, tourId: "T-900", pax: 2, status: "IGNORED" } });
  const stale = await prisma.booking.create({ data: { source: "GetYourGuide", externalId: "E2E-2", confirmationCode: "FOLK-TE2E2", externalRef: "GYGE2E2", date: "2020-05-10", slotIdx: 0, tourId: "T-900", pax: 3, status: "PENDING" } });
  return { users, hidden, stale };
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
const env = { ...process.env };
delete env.BOKUN_ACCESS_KEY; delete env.BOKUN_SECRET_KEY;
Object.assign(process.env, env);
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.users.ADMIN.email));
  await page.goto(`${BASE}/bookings`, { waitUntil: "networkidle0" });
  const link = await page.$('a[href="/admin/restore-bookings"]');
  check("1 · an admin sees Restore archived bookings in the menu", !!link);
  await page.goto(`${BASE}/admin/restore-bookings`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-restore-preview", { timeout: 20000 });
  await page.click(".js-restore-preview");
  await page.waitForSelector(".banner.danger", { timeout: 20000 });
  const banner = await page.$eval(".banner.danger", (x) => x.innerText);
  check("2 · with Bókun not connected, Preview says so and offers nothing to restore", /Bókun is not connected/.test(banner) && !(await page.$(".js-restore-apply")), banner);
  check("2 · …and nothing was restored", (await prisma.booking.findUniqueOrThrow({ where: { id: data.hidden.id } })).status === "IGNORED");
  check("1 · no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "restore-archived.png"), fullPage: true });

  // 4 — Archive stale, pressed by the admin: a note on each booking, the ids in the audit.
  const archived = await page.evaluate(async () => (await (await fetch("/api/bookings/archive-stale", { method: "POST" })).json()));
  const st = await prisma.booking.findUniqueOrThrow({ where: { id: data.stale.id } });
  const log = await prisma.auditLog.findFirst({ where: { action: "bookings.archive_stale", actorId: data.users.ADMIN.id } });
  check("4 · Archive stale notes each booking it hides and names them in its audit",
    archived.count === 1 && st.status === "IGNORED" && /^Archived as stale/.test(st.notes ?? "") && JSON.stringify(log?.detail?.ids) === JSON.stringify([data.stale.id]), JSON.stringify({ archived, notes: st.notes }));
  await page.close();

  const op = await browser.newPage();
  await op.setCookie(await sessionCookie(data.users.OPERATOR.email));
  await op.goto(`${BASE}/bookings`, { waitUntil: "networkidle0" });
  const opLink = await op.$('a[href="/admin/restore-bookings"]');
  const opTry = await op.evaluate(async () => (await fetch("/api/admin/restore-archived", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", from: "2020-01-01", to: "2020-12-31" }) })).status);
  check("3 · an operator does not see it, and the endpoint answers 403", !opLink && opTry === 403, String(opTry));
  await op.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nrestore archived e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
