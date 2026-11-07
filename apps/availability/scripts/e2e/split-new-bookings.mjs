// The Split dialog's "New bookings go to" in a real browser, against a real server and
// database: an operator names the guide who takes later bookings, it is saved on that
// guide's assignment and shown again when the dialog reopens; desktop and 390px.
// Run after `next build`:  node scripts/e2e/split-new-bookings.mjs
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
async function seed() {
  const tables = ["AuditLog", "Notification", "Booking", "Assignment", "Checkin", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "13:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op-s@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  for (const [g, name] of [["G-981", "Fon Example"], ["G-982", "Mai Example"]]) {
    await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: name, fullName: name, guideId: g, role: "GUIDE", state: "ACTIVE" } });
  }
  for (const [g, ref, pax] of [["G-982", "E2E-SP-1", 6], ["G-981", "E2E-SP-2", 3]]) {
    await prisma.assignment.create({ data: { guideId: g, date: TODAY, slotIdx: 2, tourId: "T-900", pax } });
    await prisma.booking.create({ data: { source: "manual", tourId: "T-900", date: TODAY, slotIdx: 2, pax, customerName: `Guest ${ref}`, externalRef: ref, status: "OFFERED", assignedGuideId: g } });
  }
  return { op };
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const openDialog = async (page) => {
  await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Split"), { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Split").click());
  await page.waitForSelector(".js-split-new-to select", { timeout: 20000 }).catch(async (e) => { console.log("PAGE:", (await page.evaluate(() => document.body.innerText)).slice(0, 1500)); throw e; });
};
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.op.email));
    await openDialog(page);
    const opts = await page.$$eval(".js-split-new-to option", (os) => os.map((o) => o.textContent.trim()));
    check(`${width}px: the dialog offers the departure's guides, or Ask me each time`, opts[0] === "Ask me each time" && opts.some((o) => /G-981/.test(o)) && opts.some((o) => /G-982/.test(o)), JSON.stringify(opts));
    check(`${width}px: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) {
      // The deep link from the Understaffed card opens the same dialog (it used to close at once).
      const p2 = await browser.newPage();
      await p2.setCookie(await sessionCookie(data.op.email));
      await p2.goto(`${BASE}/jobs?split=${TODAY}&slot=2`, { waitUntil: "networkidle0" });
      check("the /jobs?split= link opens the Split dialog", !!(await p2.waitForSelector(".js-split-new-to select", { timeout: 15000 }).catch(() => null)));
      await p2.close();
      await page.select(".js-split-new-to select", "G-981");
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "split-new-bookings-390.png") });
      await Promise.all([page.waitForResponse((r) => r.url().includes("/api/bookings/split") && r.ok(), { timeout: 20000 }), page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.innerText.trim() === "Assign split").click())]);
      const a = await prisma.assignment.findMany({ where: { date: TODAY, slotIdx: 2 }, orderBy: { guideId: "asc" } });
      check("saved: Fon takes new bookings, Mai does not", a.map((x) => `${x.guideId}:${x.takesNewBookings}`).join(",") === "G-981:true,G-982:false", JSON.stringify(a.map((x) => [x.guideId, x.takesNewBookings])));
    } else {
      const chosen = await page.$eval(".js-split-new-to select", (s) => s.value);
      check("reopened: the dialog shows Fon already chosen", chosen === "G-981", chosen);
    }
    check(`${width}px: no page error`, errors.length === 0, errors.join(" | ").slice(0, 200));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsplit new bookings e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
