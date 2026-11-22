// A job sheet's Account Status follows the rows ON SCREEN while they are edited (owner,
// 21 Nov 2026). The server's per-row verdict describes the SAVED sheet by index, so deleting
// or recategorising a line without saving showed the old row's status on the wrong line —
// "No account" on a mapped Ferry. In a real browser against a real server and database.
//
// Proves: with Transportation mapped and Entrance Ticket not, removing the unmapped first row
// (unsaved) leaves Ferry "Ready to sync" and the total "Ready to sync"; switching Ferry to
// Entrance Ticket shows "No account" at once; after Save and reload the same holds.
//
// Run after `next build`:  node scripts/e2e/jobsheet-live-account-status.mjs
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
const DATE = new Date(Date.now() + 7 * 3600 * 1000 - 2 * 86400_000).toISOString().slice(0, 10);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-982";
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } };
// The account chart is shared configuration other suites rely on: snapshot the two rows this
// test sets, restore them after.
const CATS = ["TRANSPORTATION", "ENTRANCE_TICKET"];
let chartBefore = [];
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  chartBefore = await prisma.peakAccountMapping.findMany({ where: { folkopsCategory: { in: CATS } } });
  const set = async (folkopsCategory, peakAccountCode) => prisma.peakAccountMapping.upsert({
    where: { folkopsCategory }, update: { peakAccountCode, isActive: true }, create: { folkopsCategory, peakAccountCode, isActive: true } });
  await set("TRANSPORTATION", "599901");
  await set("ENTRANCE_TICKET", null);
  await prisma.tour.create({ data: { id: "T-901", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-acct@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g982@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-901", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-AC-10", guideId: G, date: DATE, slotIdx: 0, tourId: "T-901", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: [
      { description: "Sample Gate", price: 100, pax: 2, expenseType: "entrance", paidBy: "company", paidBySource: "operator" },
      { description: "Ferry (Inc. Guide)", price: 6, pax: 3, expenseType: "transport", paidBy: "guide", paidBySource: "operator" },
    ] } });
}
async function restoreChart() {
  for (const c of CATS) {
    const was = chartBefore.find((r) => r.folkopsCategory === c);
    if (was) await prisma.peakAccountMapping.update({ where: { folkopsCategory: c }, data: { peakAccountCode: was.peakAccountCode, isActive: was.isActive } });
    else await prisma.peakAccountMapping.deleteMany({ where: { folkopsCategory: c } });
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
// [description, status] per expense row, and the total's status.
const statuses = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll("tr")].filter((t) => t.querySelector(".js-acct") && t.querySelector("select"));
  const total = [...document.querySelectorAll("tr")].find((t) => /total tour cost/.test(t.textContent ?? ""))?.querySelector(".js-acct")?.textContent ?? "";
  return { rows: rows.map((t) => [[...t.querySelectorAll("select")].map((s) => s.selectedOptions[0]?.textContent ?? "").join(" / ") + " " + [...t.querySelectorAll("input")].map((i) => i.value).join(" "), t.querySelector(".js-acct").textContent]), total };
});
const ferry = (s) => s.rows.find(([d]) => /Ferry/.test(d))?.[1];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setCookie(await sessionCookie("op-acct@example.test"));
  const open = () => page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
  await open();
  await page.waitForSelector(".js-acct", { timeout: 20000 });
  let s = await statuses(page);
  check("loaded: the unmapped entrance row says No account, Ferry (mapped) says Ready to sync, the total Needs review",
    s.rows.length === 2 && s.rows[0][1] === "No account" && ferry(s) === "Ready to sync" && /Needs review/.test(s.total), JSON.stringify(s));

  // Remove the first row WITHOUT saving: Ferry is now row 1 — it must keep its own status.
  await page.evaluate(() => [...document.querySelectorAll('button[title="Remove this expense line"]')][0].click());
  await pause(400);
  s = await statuses(page);
  check("unsaved delete: Ferry still says Ready to sync (not the removed row's No account), and so does the total",
    s.rows.length === 1 && ferry(s) === "Ready to sync" && /Ready to sync/.test(s.total), JSON.stringify(s));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "live-status-after-delete.png"), fullPage: true });

  // Recategorise Ferry to the unmapped category on screen: the badge follows at once.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr")].find((t) => t.querySelector(".js-acct") && t.querySelector("select"));
    const sel = row.querySelector("select");
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(sel, "entrance"); sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await pause(400);
  s = await statuses(page);
  check("unsaved category change to an unmapped one: No account at once, total Needs review", s.rows[0]?.[1] === "No account" && /Needs review/.test(s.total), JSON.stringify(s));
  // …and back.
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll("tr")].find((t) => t.querySelector(".js-acct") && t.querySelector("select")).querySelector("select");
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(sel, "transport"); sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await pause(400);
  s = await statuses(page);
  check("back to Transportation: Ready to sync", ferry(s) === "Ready to sync" && /Ready to sync/.test(s.total), JSON.stringify(s));

  // Save, reload: the server's verdict agrees with what the screen showed.
  await page.evaluate(() => [...document.querySelectorAll(".js-bar button")].find((x) => x.textContent.trim() === "Save").click());
  await page.waitForFunction(() => /saved/i.test([...document.querySelectorAll(".js-bar span")].map((x) => x.textContent).join(" ")), { timeout: 20000 }).catch(() => {});
  await pause(800);
  const saved = await prisma.jobSheet.findUniqueOrThrow({ where: KEY });
  check("saved: one row, Ferry, Transportation", saved.expenses.length === 1 && saved.expenses[0].expenseType === "transport", JSON.stringify(saved.expenses.map((e) => [e.description, e.expenseType])));
  await open();
  await page.waitForSelector(".js-acct", { timeout: 20000 });
  s = await statuses(page);
  check("after reload: Ferry Ready to sync, total Ready to sync", ferry(s) === "Ready to sync" && /Ready to sync/.test(s.total), JSON.stringify(s));

  // 390 px: nothing pushes the page sideways.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await open();
  await page.waitForSelector(".js-acct", { timeout: 20000 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("390 px: the page does not scroll sideways", over <= 0, `over ${over}px`);
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser.close();
  server.kill();
  await restoreChart().catch((e) => console.error("could not restore the account chart:", e));
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
