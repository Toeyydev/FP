// The Job process board and the job sheet's stage strip, in a real browser against a real
// server and database.
//
// Proves: the board draws the process in two lanes and counts the jobs standing on each step;
// a declined offer is counted in the admin's lane; clicking a step lists its jobs with the
// next thing to do and a link to do it; "Waiting on admin" filters by lane; the job sheet
// shows the same stage, and it moves when the sheet is approved.
//
// Run after `next build`:  node scripts/e2e/job-process.mjs
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
const G = "G-985";
const FEE = { price: 1000, time: 1, whtPct: 3 };
async function seed() {
  const tables = ["AuditLog", "Notification", "JobOfferResponse", "JobOffer", "Checkin", "TourReport", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "op-jp@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g985@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  let n = 0;
  const booking = (date, slotIdx) => prisma.booking.create({ data: { source: "Example OTA", externalRef: `E2E-JP-${++n}`, confirmationCode: `E2E-JP-${n}`, customerName: `Guest ${n}`, date, slotIdx, tourId: "T-900", pax: 2, status: "PENDING" } });
  const assign = (date, slotIdx = 0) => prisma.assignment.create({ data: { guideId: G, date, slotIdx, tourId: "T-900", pax: 2 } });
  const sheet = (date, ref, over = {}) => prisma.jobSheet.create({ data: { ref, guideId: G, date, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses: [], ...over } });
  // In 3 days: a departure nobody holds; in 4 days: an offer the only guide declined.
  await booking(day(3), 0);
  await booking(day(4), 0);
  await prisma.jobOffer.create({ data: { tourId: "T-900", date: day(4), slotIdx: 0, status: "OPEN", expiresAt: new Date(Date.now() + 3600_000), responses: { create: [{ guideId: G, response: "DENIED" }] } } });
  // In 2 days: assigned. 5 days ago: no report. 4 days ago: reported, to review. 3 days ago: approved, to pay.
  await assign(day(2));
  await assign(day(-5));
  await assign(day(-4)); await sheet(day(-4), "FOLK-TEST-JP-REVIEW"); await prisma.tourReport.create({ data: { guideId: G, date: day(-4), slotIdx: 0, tourId: "T-900" } });
  await assign(day(-3)); await sheet(day(-3), "FOLK-TEST-JP-PAY", { approvalStatus: "APPROVED" });
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
const nodeCount = (page, stage) => page.$eval(`.proc-node[data-stage="${stage}"] b`, (b) => b.innerText);
const tableStages = (page) => page.$$eval(".js-proc-table tbody tr[data-stage]", (trs) => trs.map((t) => t.dataset.stage));
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setCookie(await sessionCookie("op-jp@example.test"));
  await page.goto(`${BASE}/process`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".proc-node", { timeout: 20000 });
  const counts = {};
  for (const s of ["BOOKING_RECEIVED", "OFFER_SENT", "OFFER_RETURNED", "ASSIGNED", "AWAITING_REPORT", "AWAITING_REVIEW", "AWAITING_TRANSFER", "AWAITING_PEAK", "CLOSED"]) counts[s] = await nodeCount(page, s);
  check("each step shows the jobs standing on it", JSON.stringify(counts) === JSON.stringify({ BOOKING_RECEIVED: "1", OFFER_SENT: "0", OFFER_RETURNED: "1", ASSIGNED: "1", AWAITING_REPORT: "1", AWAITING_REVIEW: "1", AWAITING_TRANSFER: "1", AWAITING_PEAK: "0", CLOSED: "0" }), JSON.stringify(counts));
  const lanes = await page.$$eval(".proc-lane", (ls) => ls.map((l) => [l.dataset.lane, [...l.querySelectorAll(".proc-node")].map((n) => n.dataset.stage)]));
  check("the declined offer is in the admin's lane, the guide's steps in the guide's",
    lanes[0][0] === "ADMIN" && lanes[0][1].includes("OFFER_RETURNED") && lanes[0][1].includes("AWAITING_REVIEW") && lanes[1][0] === "GUIDE" && lanes[1][1].join() === "OFFER_SENT,ASSIGNED,CHECKED_IN,AWAITING_REPORT", JSON.stringify(lanes));
  check("the list starts with every open job", (await tableStages(page)).length === 6);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "job-process-board.png"), fullPage: true });

  await page.$eval('.proc-node[data-stage="AWAITING_REVIEW"]', (b) => b.click());
  await pause(300);
  const review = await page.$eval(".js-proc-table tbody", (x) => x.innerText.replace(/\s+/g, " "));
  check("clicking a step lists its jobs with the next thing to do", (await tableStages(page)).join() === "AWAITING_REVIEW" && /FOLK-TEST-JP-REVIEW/.test(review) && /Review the expenses and approve the job sheet/.test(review) && /4 d/.test(review), review.slice(0, 200));
  const href = await page.$eval(".js-proc-table tbody a.btn", (a) => a.getAttribute("href"));
  check("…and links to the screen where it is done", href === `/job-sheet?guideId=${G}&date=${day(-4)}&slotIdx=0`, href);
  await page.$eval(".js-proc-admin", (b) => b.click());
  await pause(300);
  check("Waiting on admin holds the admin's jobs only", (await tableStages(page)).sort().join() === "AWAITING_REVIEW,AWAITING_TRANSFER,BOOKING_RECEIVED,OFFER_RETURNED", (await tableStages(page)).join());

  // The job sheet says the same, and moves when the sheet is approved.
  await page.goto(`${BASE}${href}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-proc-strip", { timeout: 20000 });
  check("the job sheet shows the same stage and who it is waiting for", (await page.$eval(".js-proc-strip", (x) => x.dataset.stage)) === "AWAITING_REVIEW" && /Waiting on the admin/.test(await page.$eval(".proc-strip-next", (x) => x.innerText)));
  await page.evaluate(() => [...document.querySelectorAll(".js-bar button")].find((x) => /^Approve/.test(x.textContent.trim()))?.click());
  await page.waitForFunction(() => document.querySelector(".js-proc-strip")?.dataset.stage === "AWAITING_TRANSFER", { timeout: 20000 }).catch(() => {});
  check("approving the sheet moves the job to To pay", (await page.$eval(".js-proc-strip", (x) => x.dataset.stage)) === "AWAITING_TRANSFER");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "job-process-strip.png") });

  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/process`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".proc-node");
  check("on a phone the page does not scroll sideways (the board scrolls inside its panel)", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "job-process-phone.png") });
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
