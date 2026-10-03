// The historical evidence page in a real browser, against a real server and database.
//
// Proves the 13 Sep 2026 incident cannot recur, end to end on a LOCAL server: a departure
// with a guide and a saved job sheet of 6 guests receives a late booking (2 pax) through the
// real Bokun webhook route; the booking is placed on the guide's job, the sheet shows 8
// expected guests (actual: not reported), the (Inc. Guide) lines read 9, and the sheet says
// "Synced from booking · 6 → 8". A duplicate delivery changes nothing.
//
// Run after `next build`:  node scripts/e2e/booking-reconcile.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates) and the managed browser. Never
// point it at production: it posts a synthetic webhook to the local server it starts.
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
const PORT = Number(process.env.E2E_PORT ?? 3992);
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
const DAY = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000);
const DATE = DAY.toISOString().slice(0, 10);
async function seed() {
  const tables = ["AuditLog", "Notification", "ProductMap", "TourPayment", "ExpenseCertificate", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  await prisma.productMap.create({ data: { productKey: "riverside temples", productName: "Riverside Temples", tourId: "T-900" } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const guide = await prisma.user.create({ data: { email: "g907@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: "G-907", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const mk = (ref, pax) => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, confirmationCode: `GET-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax, status: "OFFERED" } });
  await mk("GYGAAA4", 4); await mk("GYGBBB2", 2);
  await prisma.assignment.create({ data: { guideId: "G-907", date: DATE, slotIdx: 0, tourId: "T-900", pax: 6 } });
  const fill = (d, price, g, unit) => ({ description: d, price, pax: g, expenseType: unit });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-E2E-01", guideId: "G-907", date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
    bookings: [{ name: "Guest GYGAAA4", bookingNo: "GYGAAA4", bookedPax: 4, actualPax: null, tickets: "", status: "" }, { name: "Guest GYGBBB2", bookingNo: "GYGBBB2", bookedPax: 2, actualPax: null, tickets: "", status: "" }],
    expenses: [fill("Water (Inc. Guide)", 10, 7, "meal"), fill("Ferry (Inc. Guide)", 11, 7, "transport"), fill("Grand Palace", 500, 6, "entrance"), fill("Bus (Inc. Guide)", 15, 7, "transport")] } });
  return { op, guide };
}
const [y, m, d] = DATE.split("-").map(Number);
const lateBooking = { bookingId: 77001, externalBookingReference: "VIA-E2E-LATE", startDateTime: Date.UTC(y, m - 1, d, 8, 30), bookingChannel: { title: "Viator.com" },
  customer: { firstName: "Late", lastName: "Guest" }, activityBookings: [{ product: { title: "Riverside Temples" }, productConfirmationCode: "FOLK-T77001", invoice: { lineItems: [{ quantity: 2 }] } }] };

// ── server ───────────────────────────────────────────────────────────────────
async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", BOKUN_WEBHOOK_TOKEN: "e2e-webhook-token", AUTH_SECRET: process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789" },
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
const post = () => fetch(`${BASE}/api/bokun/webhook?token=e2e-webhook-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lateBooking) });
try {
  const r1 = await post();
  check("the local webhook accepts the late booking", r1.status === 200, String(r1.status));
  await pause(500);
  const late = await prisma.booking.findFirst({ where: { externalRef: "VIA-E2E-LATE" } });
  check("the late booking is placed on the guide's job", late?.status === "OFFERED" && late?.tourId === "T-900", `${late?.status} ${late?.tourId}`);
  const sheet = await prisma.jobSheet.findFirstOrThrow({ where: { ref: "FOLK-TEST-E2E-01" } });
  const exp = Object.fromEntries(sheet.expenses.map((e) => [e.description, e.pax]));
  check("the saved sheet has 8 expected guests and (Inc. Guide) lines at 9 (8 + guide, not 10)",
    sheet.bookings.reduce((s, b) => s + (b.bookedPax ?? 0), 0) === 8 && exp["Water (Inc. Guide)"] === 9 && exp["Ferry (Inc. Guide)"] === 9 && exp["Bus (Inc. Guide)"] === 9 && exp["Grand Palace"] === 8, JSON.stringify(exp));
  const r2 = await post();
  await pause(500);
  const again = await prisma.jobSheet.findFirstOrThrow({ where: { ref: "FOLK-TEST-E2E-01" } });
  const lateNotices = await prisma.notification.count({ where: { userId: data.op.id, message: { startsWith: "LATE BOOKING" } } });
  check("a duplicate delivery changes nothing and alerts nobody twice", r2.status === 200 && again.bookings.length === 3 && lateNotices === 1, `${again.bookings.length} rows, ${lateNotices} notices`);

  for (const [who, email, sel] of [["operator", data.op.email, "Job Details"], ["guide", data.guide.email, "Your customers"]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(email));
    await page.goto(`${BASE}/job-sheet?guideId=G-907&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="Guest counts"]', { timeout: 20000 });
    await pause(500);
    const text = await page.$$eval('[aria-label="Guest counts"]', (xs) => xs.map((x) => x.innerText).join(" | "));
    check(`${who}: expected and actual guests are shown separately, with the booking sync`, /Expected guests\s*8/.test(text) && /Actual guests\s*Not reported/.test(text) && /Synced from booking .* 6 → 8 guests/.test(text) && errors.length === 0, text.replace(/\s+/g, " ").slice(0, 200));
    if (who === "guide") {
      const lines = await page.$$eval(".gs-exp li", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ")));
      const gp = lines.find((l) => l.startsWith("Grand Palace")) ?? "", water = lines.find((l) => l.startsWith("Water")) ?? "";
      check("guide: \"(incl. guide)\" appears only on lines that include the guide", water.includes("(incl. guide)") && !gp.includes("(incl. guide)"), `${water} | ${gp}`);
    }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `booking-reconcile-${who}.png`), fullPage: false });
    await page.close();
  }

  // An operator has the sheet open (8 guests). Another late booking arrives and the sheet
  // becomes 10 behind their back. Pressing Approve must NOT approve what they never saw.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.op.email));
    await page.goto(`${BASE}/job-sheet?guideId=G-907&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="Guest counts"]', { timeout: 20000 });
    const second = { ...lateBooking, bookingId: 77002, externalBookingReference: "VIA-E2E-LATE2", activityBookings: [{ ...lateBooking.activityBookings[0], productConfirmationCode: "FOLK-T77002" }] };
    const r3 = await fetch(`${BASE}/api/bokun/webhook?token=e2e-webhook-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(second) });
    await pause(500);
    const behind = await prisma.jobSheet.findFirstOrThrow({ where: { ref: "FOLK-TEST-E2E-01" } });
    const clickApprove = () => page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "Approve"); if (!b) return false; b.click(); return true; });
    const clicked = await clickApprove();
    await pause(1500);
    const shown = await page.evaluate(() => document.body.innerText);
    const after = await prisma.jobSheet.findFirstOrThrow({ where: { ref: "FOLK-TEST-E2E-01" } });
    check("operator: approving a sheet that changed since it was opened is refused, with the reason on screen",
      r3.status === 200 && behind.bookings.length === 4 && clicked && shown.includes("Job Sheet changed since you reviewed it. Please review the latest version before approving.") && after.approvalStatus === null && errors.length === 0,
      `rows ${behind.bookings.length}, clicked ${clicked}, approval ${after.approvalStatus}`);
    // After reviewing the latest version (a reload), approving works.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="Guest counts"]', { timeout: 20000 });
    await clickApprove();
    await pause(1500);
    const approved = await prisma.jobSheet.findFirstOrThrow({ where: { ref: "FOLK-TEST-E2E-01" } });
    check("operator: after reloading the latest version, Approve works", approved.approvalStatus === "APPROVED", String(approved.approvalStatus));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "booking-reconcile-stale-approval.png"), fullPage: false });
    await page.close();
  }

  // A tour that already ran, with guests that never reached its sheet: the sheet says so
  // and one press adds them (append-only) and marks every waiting booking as guided.
  {
    const PAST = "2025-03-09";
    await prisma.assignment.create({ data: { guideId: "G-907", date: PAST, slotIdx: 2, tourId: "T-900", pax: 2 } });
    const pk = (ref, pax, status) => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, customerName: `Guest ${ref}`, date: PAST, slotIdx: 2, tourId: "T-900", pax, status } });
    await pk("GYGPAST01", 2, "OFFERED"); await pk("GYGPAST02", 2, "PENDING"); await pk("GYGPAST03", 1, "PENDING");
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-E2E-PAST", guideId: "G-907", date: PAST, slotIdx: 2, tourId: "T-900", status: "Confirmed",
      bookings: [{ name: "Guest GYGPAST01", bookingNo: "GYGPAST01", bookedPax: 2, actualPax: 2, tickets: "", status: "" }], expenses: [] } });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.op.email));
    await page.goto(`${BASE}/job-sheet?guideId=G-907&date=${PAST}&slotIdx=2`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".js-past-gaps", { timeout: 20000 });
    const banner = await page.$eval(".js-past-gaps", (e) => e.innerText);
    check("past sheet: the guests missing from it, and the booking still waiting, are named",
      /2 bookings at this departure are not on this sheet/.test(banner) && /GYGPAST02 ×2/.test(banner) && /GYGPAST03 ×1/.test(banner) && /GYGPAST01 · OFFERED/.test(banner), banner.replace(/\s+/g, " ").slice(0, 220));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "past-sheet-gaps.png"), fullPage: false });
    await page.click(".js-past-gaps-fix");
    await page.waitForFunction(() => !document.querySelector(".js-past-gaps"), { timeout: 15000 });
    const sheetAfter = await prisma.jobSheet.findFirstOrThrow({ where: { ref: "FOLK-TEST-E2E-PAST" } });
    const statuses = (await prisma.booking.findMany({ where: { date: PAST }, orderBy: { externalRef: "asc" } })).map((b) => b.status);
    const rowsShown = await page.$$eval("table.js-table tbody tr:not(.js-total)", (trs) => trs.length);
    check("past sheet: one press appends the two bookings after the existing row and marks all three guided",
      sheetAfter.bookings.map((r) => r.bookingNo).join(",") === "GYGPAST01,GYGPAST02,GYGPAST03" && statuses.join(",") === "ASSIGNED,ASSIGNED,ASSIGNED" && rowsShown >= 3 && errors.length === 0,
      JSON.stringify({ rows: sheetAfter.bookings.map((r) => r.bookingNo), statuses, rowsShown, errors }));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nbooking reconcile e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
