// The top of the operator's job sheet: Back · title · More ▾ · Approve · Save, then Tour day —
// no "Check this job" cards (owner 2026-10-18: not needed, it repeated the sheet). In a real
// browser against a real server and database.
//
// Proves: the cards are gone; Approve sits beside Save and approves the sheet; once approved
// the bar says so and Unapprove is in More; the guide-fee table is on screen with WHT and the
// fee after WHT; the bar fits a phone; the guide sees neither Approve nor the operator bar.
//
// Run after `next build`:  node scripts/e2e/jobsheet-operator-top.mjs
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
const G = "G-971";
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } };
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-ck@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g971@example.test", displayName: "Ploy Example", fullName: "Ploy Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 3 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-CK-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
    bookings: [{ name: "Guest One", bookingNo: "EX-1", bookedPax: 2, actualPax: null, tickets: "", status: "" }, { name: "Guest Two", bookingNo: "EX-2", bookedPax: 1, actualPax: null, tickets: "", status: "" }],
    guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: [{ description: "Water (Inc. Guide)", expenseType: "meal", price: 10, pax: 4, paidBy: "guide", paidBySource: "operator" }] } });
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
const URL_ = `${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setCookie(await sessionCookie("op-ck@example.test"));
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-bar-op", { timeout: 20000 });
  check("no Check this job cards", (await page.$(".js-check, .js-check-card")) === null);
  const bar = await page.$$eval(".js-bar-op > button, .js-bar-actions > button, .js-bar-actions > span.js-approved-chip, .js-more-btn", (xs) => xs.map((x) => x.innerText.trim()));
  check("the bar: Back · More ▾ · Approve · Save", bar.includes("← Back") && bar.includes("More ▾") && bar.includes("Approve") && bar.includes("Save"), JSON.stringify(bar));
  // The guide fee is on screen — rate, WHT and the fee after WHT (owner 2026-10-18).
  const fee = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const table = document.querySelector(".js-pay-table");
    return { input: vis(document.querySelector('input[title="Agreed rate"]')), table: vis(table), text: table ? table.innerText.replace(/\s+/g, " ") : "" };
  });
  check("the guide fee table is on screen: rate, WHT and Guide fee, net ฿970", fee.input && fee.table && /WHT on fee −฿30\.00/.test(fee.text) && /Guide fee, net ฿970\.00/.test(fee.text), fee.text.slice(0, 160));

  // Approve beside Save approves the sheet; then the bar says Approved and Unapprove is in More.
  await page.click(".js-approve");
  await page.waitForSelector(".js-approved-chip", { timeout: 15000 }).catch(() => {});
  const after = await prisma.jobSheet.findUniqueOrThrow({ where: KEY, select: { approvalStatus: true } });
  check("Approve in the bar approves the sheet; the bar then says ✓ Approved", after.approvalStatus === "APPROVED" && (await page.$(".js-approved-chip")) !== null && (await page.$(".js-approve")) === null, after.approvalStatus);
  await page.click(".js-more-btn");
  await page.waitForSelector(".js-more-menu.open .js-unapprove", { timeout: 5000 }).catch(() => {});
  check("…and Unapprove is in More", (await page.$(".js-more-menu.open .js-unapprove")) !== null);
  await page.click(".js-more-menu.open .js-unapprove");
  await page.waitForSelector(".js-approve", { timeout: 15000 }).catch(() => {});
  const back = await prisma.jobSheet.findUniqueOrThrow({ where: KEY, select: { approvalStatus: true } });
  check("Unapprove takes it back; Approve is in the bar again", back.approvalStatus !== "APPROVED" && (await page.$(".js-approve")) !== null, String(back.approvalStatus));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "jobsheet-operator-top.png"), fullPage: false });

  // A phone: the bar wraps, nothing reaches past the screen.
  await page.setViewport({ width: 390, height: 900 });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-bar-op");
  const fit = await page.$eval(".js-bar-op", (x) => Math.max(...[...x.querySelectorAll("*")].map((c) => c.getBoundingClientRect().right).filter((r) => r > 0)) <= window.innerWidth + 1);
  check("on a phone the bar fits", fit);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "jobsheet-operator-top-phone.png"), fullPage: false });

  // The guide sees neither Approve nor the operator's bar.
  const gp = await browser.newPage();
  await gp.setCookie(await sessionCookie("g971@example.test"));
  await gp.goto(URL_, { waitUntil: "networkidle0" });
  await gp.waitForSelector(".guide-sum", { timeout: 20000 });
  check("the guide's view has no Approve and no operator bar", (await gp.$(".js-approve, .js-bar-op")) === null);
  await gp.close();
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
