// A food tour's food cost is one figure against the food advance (owner, 2026-10-27), on the
// guide's job sheet page, in a real browser against a real server and database.
//
// Proves, on the page (signed in as the guide):
//   1. a food tour shows "ค่าอาหาร Food Tour" with the advance, not the itemised table
//   2. what is left to return, and what the company adds when the food cost more
//   3. Send stores one row from the advance plus the difference as the guide's own money
//   4. at phone width (390px) the page has no sideways scroll
//
// Run after `next build`:  node scripts/e2e/food-tour-total.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET.
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
const PORT = Number(process.env.E2E_PORT ?? 3994);
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
const G = "G-982";
const DATE = "2026-01-15"; // in the past: the guide's report is open
const SLOT = 7; // 18:30
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: SLOT } };
async function seed() {
  const tables = ["AuditLog", "Notification", "GuideAdvance", "TourReport", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-009", name: "Example Night Food Walk", time: "18:30", durationMin: 210 } });
  const guide = await prisma.user.create({ data: { email: "g982@example.test", displayName: "Nam Example", fullName: "Nam Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: SLOT, tourId: "T-009", pax: 4 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-FOOD-02", guideId: G, date: DATE, slotIdx: SLOT, tourId: "T-009", status: "Confirmed",
    bookings: [{ name: "Guest Example", bookingNo: "GYG-E2E-FOOD", bookedPax: 4, actualPax: 4, tickets: "", status: "Confirmed" }], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
  await prisma.guideAdvance.create({ data: { guideId: G, date: DATE, slotIdx: SLOT, amount: 2000, paidAt: new Date(`${DATE}T01:00:00Z`), method: "bank", txRef: "TX-E2E-FOOD",
    advanceNo: "FOLK-ADV-202601-901", advanceDate: DATE, amountSatang: 200000, accountingPeriod: "2026-01", slipUrl: "https://example.test/advance-slip", allowedCategories: ["meal"] } });
  return { guide };
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

// ── the test ─────────────────────────────────────────────────────────────────
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.$eval(sel, (x) => x.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
async function typeSpent(page, value) {
  const input = await page.$(".js-food-spent");
  await input.click({ clickCount: 3 });
  await input.type(String(value));
  await pause(200);
}
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setCookie(await sessionCookie(data.guide.email));
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=${SLOT}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-food-report", { timeout: 20000 });

  // 1 — one figure, against the advance
  check("1 · a food tour asks for the food cost as one figure", /ค่าอาหาร Food Tour/.test((await text(page, ".js-food-report")) ?? ""));
  check("1 · with the advance the company sent", (await text(page, ".js-food-adv")) === "฿2,000.00" || /2,000/.test((await text(page, ".js-food-adv")) ?? ""), String(await text(page, ".js-food-adv")));
  check("1 · and no itemised expense table", !(await page.$('input[placeholder="e.g. Grand Palace ticket"]')));

  // 2 — what is left, or what the company adds
  await typeSpent(page, 1850);
  const left = (await text(page, ".js-food-diff")) ?? "";
  check("2 · spent ฿1,850 of ฿2,000: ฿150 to return", /เหลือคืนบริษัท/.test(left) && /150/.test(left), left);
  await typeSpent(page, 2100);
  const more = (await text(page, ".js-food-diff")) ?? "";
  check("2 · spent ฿2,100: the company adds ฿100", /บริษัทจ่ายเพิ่มให้คุณ/.test(more) && /100/.test(more), more);
  if (SHOTS) await (await page.$(".js-food-report")).screenshot({ path: join(SHOTS, "food-total.png") });

  // 3 — Send
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/jobsheet/expenses") && r.request().method() === "POST", { timeout: 15000 });
  await page.click(".js-food-submit");
  const res = await sent;
  check("3 · sent", res.ok(), String(res.status()));
  await pause(500);
  const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: KEY })).guideExpenses ?? [];
  const brief = rows.map((r) => `${r.description}|${r.price}|${r.paidBy}|${r.expenseType}`);
  check("3 · stored: ฿2,000 from the advance + ฿100 the guide's own money", JSON.stringify(brief) === JSON.stringify(["ค่าอาหาร Food Tour|2000|advance|meal", "ค่าอาหาร Food Tour (เกินเงินล่วงหน้า)|100|guide|meal"]), JSON.stringify(brief));
  check("3 · both marked as the guide's own choice of payer", rows.every((r) => r.paidBySource === "guide"), JSON.stringify(rows.map((r) => r.paidBySource)));

  // 4 — phone width
  await page.setViewport({ width: 390, height: 844 });
  await pause(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("4 · at 390px the page has no sideways scroll", overflow <= 0, `overflow ${overflow}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "food-total-phone.png"), fullPage: false });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nfood tour total e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
