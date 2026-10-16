// "Check this job" on the operator's job sheet — the four questions, in order: who came,
// what the guide spent, approve, pay & PEAK. In a real browser against a real server and
// database.
//
// Proves: each card reads its state from the sheet; the first one not done is highlighted;
// Guests and Expenses open the part of the sheet that answers them; Approve on the card
// approves the sheet; the cards fit a phone without sideways scrolling.
//
// Run after `next build`:  node scripts/e2e/jobsheet-checklist.mjs
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
const cards = (page) => page.$$eval(".js-check .js-check-card", (xs) => xs.map((x) => ({ step: x.dataset.step, done: x.classList.contains("done"), now: x.classList.contains("now"), text: x.innerText.replace(/\s+/g, " "), tip: x.title })));
const URL_ = `${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=0`;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setCookie(await sessionCookie("op-ck@example.test"));
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-check", { timeout: 20000 });
  let c = await cards(page);
  check("four cards in order: who came, what the guide spent, approve, pay & PEAK", JSON.stringify(c.map((x) => x.step)) === JSON.stringify(["guests", "expenses", "approve", "pay"]), JSON.stringify(c.map((x) => x.step)));
  check("guests not counted yet → Who came is the one highlighted", !c[0].done && c[0].now && /2 bookings · 3 booked · not counted yet/.test(c[0].text), c[0].text);
  check("What the guide spent says the guide has not reported", /1 row · ฿40\.00 · guide has not reported/.test(c[1].text), `${c[1].text} || ${c[1].tip}`);
  check("Approve names what the guide will be paid", /Pay the guide ฿1,010\.00 · fee ฿970\.00 \+ reimbursement ฿40\.00/.test(c[2].text), c[2].text);

  // Guests opens the guests part of the sheet; Expenses the expenses part.
  await page.evaluate(() => [...document.querySelectorAll('.js-check-card[data-step="expenses"] button')][0].click());
  await pause(400);
  const tabs = await page.evaluate(() => ({ guests: getComputedStyle(document.getElementById("js-guests")).display, exp: getComputedStyle(document.getElementById("js-expenses")).display }));
  check("Expenses opens the expenses part of the sheet", tabs.exp !== "none" && tabs.guests === "none", JSON.stringify(tabs));
  await page.evaluate(() => [...document.querySelectorAll('.js-check-card[data-step="guests"] button')][0].click());
  await pause(400);
  const tabs2 = await page.evaluate(() => ({ guests: getComputedStyle(document.getElementById("js-guests")).display, exp: getComputedStyle(document.getElementById("js-expenses")).display }));
  check("Guests opens the guests part of the sheet", tabs2.guests !== "none" && tabs2.exp === "none", JSON.stringify(tabs2));

  // Counted and reported: the highlight moves on to Approve.
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: KEY });
  await prisma.jobSheet.update({ where: KEY, data: { bookings: sheet.bookings.map((b, i) => ({ ...b, actualPax: i === 0 ? 2 : 0, noShowPax: i === 0 ? 0 : 1 })), guideExpensesAt: new Date(), guideExpenses: sheet.expenses } });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-check");
  c = await cards(page);
  check("counted and reported → Who came and What the guide spent done, Approve highlighted", c[0].done && /2 of 3 came · 1 no-show/.test(c[0].text) && c[1].done && /guide reported/.test(c[1].text) && c[2].now && !c[2].done, JSON.stringify(c.map((x) => [x.step, x.done, x.now])));

  // Approve on the card approves the sheet.
  await page.click(".js-check-approve");
  await page.waitForFunction(() => document.querySelector('.js-check-card[data-step="approve"]')?.classList.contains("done"), { timeout: 15000 }).catch(() => {});
  const after = await prisma.jobSheet.findUniqueOrThrow({ where: KEY, select: { approvalStatus: true } });
  c = await cards(page);
  check("Approve on the card approves the sheet; Pay & PEAK is next", after.approvalStatus === "APPROVED" && c[2].done && c[3].now && /Approved — transfer on Payments/.test(c[3].text), JSON.stringify({ status: after.approvalStatus, cards: c.map((x) => [x.step, x.done, x.now]) }));
  if (SHOTS) { await page.$eval(".js-check", (x) => x.scrollIntoView({ block: "start" })); await page.screenshot({ path: join(SHOTS, "jobsheet-checklist.png"), fullPage: false }); }

  // A phone: one card per line, nothing sideways.
  await page.setViewport({ width: 390, height: 900 });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-check");
  // (The operator's sheet below is wider than a phone — its tables — so this checks the
  // checklist itself: one card per line, nothing inside it scrolls sideways.)
  const fit = await page.$eval(".js-check", (x) => ({ over: x.scrollWidth - x.clientWidth, lefts: [...new Set([...x.querySelectorAll(".js-check-card")].map((c) => Math.round(c.getBoundingClientRect().left)))].length }));
  check("on a phone the cards stack one per line, nothing sideways inside the checklist", fit.over <= 1 && fit.lefts === 1, JSON.stringify(fit));
  if (SHOTS) { await page.$eval(".js-check", (x) => x.scrollIntoView({ block: "start" })); await page.screenshot({ path: join(SHOTS, "jobsheet-checklist-phone.png"), fullPage: false }); }

  // The guide does not get the operator's checklist.
  const gp = await browser.newPage();
  await gp.setCookie(await sessionCookie("g971@example.test"));
  await gp.goto(URL_, { waitUntil: "networkidle0" });
  await gp.waitForSelector(".guide-sum", { timeout: 20000 });
  check("the guide's view has no checklist", (await gp.$(".js-check")) === null);
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
