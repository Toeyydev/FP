// Adding the transfer missing from a recorded payment, in a real browser against a real server
// and database (Google faked at the network layer by scripts/e2e/drive-fake.cjs).
//
// Proves, on Payments → Guide Payments:
//   1. an operator opening a payment recorded as one transfer sees no "Add the missing transfer…"
//   2. an admin does; the form shows the running total and refuses a wrong one with the reason
//   3. ฿100 (the recorded slip) + ฿870 with its slip makes the payment two transfers; the total,
//      the job's figures and the payment date are exactly as before; the page lists both
//   4. the button is gone once the payment has its transfers
//
// Run after `next build`:  node scripts/e2e/missing-transfer.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
//
// All data invented — this repo is public.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
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
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const SLIP = join(tmpdir(), "folkops-e2e-slip.png");
writeFileSync(SLIP, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const G = "G-955";
const JOB = { jobNo: "FOLK-TEST-MT-01", date: TODAY, slotIdx: 0 };
function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
async function seed() {
  const tables = ["AuditLog", "Notification", "GoogleCalendar", "GuidePaymentTransfer", "GuidePaymentSupplementLine", "SupplementalPayment", "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument",
    "PaymentEvidence", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const admin = await prisma.user.create({ data: { email: "admin-mt@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  const op = await prisma.user.create({ data: { email: "op-mt@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g955@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("e2e-refresh-token"), email: "admin-mt@example.test" } });
  await prisma.assignment.create({ data: { guideId: G, date: JOB.date, slotIdx: 0, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: JOB.jobNo, guideId: G, date: JOB.date, slotIdx: 0, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [] } });
  // Recorded as ONE transfer of ฿970 — the slip really said ฿100.
  const p = await prisma.guidePayment.create({ data: { paymentNo: "FOLK-PMT-209901-001", guideId: G, accountingPeriod: TODAY.slice(0, 7), paymentDate: TODAY, jobTotal: 970, adjustmentTotal: 0, amountTransferred: 970,
    status: "RECORDED", source: "MANUAL", bankRef: "BANK-E2E-ONE", slipUrl: "https://drive.google.com/file/d/first-slip/view", createdById: op.id,
    jobs: { create: [{ guideId: G, date: JOB.date, slotIdx: 0, jobNo: JOB.jobNo, accountingDate: JOB.date, feeGross: 1000, wht: 30, reimbursement: 0, reviewReward: 0, payable: 970 }] } } });
  await prisma.tourPayment.create({ data: { guideId: G, date: JOB.date, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date(), guidePaymentId: p.id } });
  return { admin, op, p };
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
const MT = ".js-missing-transfer";
async function setField(page, name, value) {
  await page.evaluate((scope, name, value) => {
    const el = document.querySelector(`${scope} [name="${name}"]`);
    if (!el) throw new Error(`no field ${name}`);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, MT, name, value);
  await pause(150);
}
async function openPayment(page) {
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await page.evaluate(() => [...document.querySelectorAll("button.subtab")].find((b) => b.innerText.trim() === "Guide Payments").click());
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Open"), { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Open").click());
  await page.waitForSelector("#pmt-h", { timeout: 15000 });
  await pause(300);
}

const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
try {
  // 1. operator
  const op = await browser.newPage();
  op.on("pageerror", (e) => errors.push(String(e)));
  await op.setViewport({ width: 1280, height: 900 });
  await op.setCookie(await sessionCookie("op-mt@example.test"));
  await openPayment(op);
  check("an operator sees the payment but no Add the missing transfer", !(await op.$(".js-add-missing-transfer")) && (await op.$eval("#pmt-h", (x) => x.innerText)) === "FOLK-PMT-209901-001");
  await op.close();

  // 2. admin
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844 });
  await page.setCookie(await sessionCookie("admin-mt@example.test"));
  await openPayment(page);
  check("an admin sees Add the missing transfer", !!(await page.$(".js-add-missing-transfer")));
  await page.$eval(".js-add-missing-transfer", (b) => b.click());
  await page.waitForSelector(MT);
  await setField(page, "recorded", "100");
  await setField(page, "amount", "800");
  await setField(page, "date", TODAY);
  await setField(page, "bankRef", "BANK-E2E-TWO");
  await setField(page, "reason", "first transfer was 100, not 970 (example)");
  await (await page.$(`${MT} input[type="file"]`)).uploadFile(SLIP);
  await pause(300);
  const recon = await page.$eval(`${MT} .pay-recon`, (x) => x.innerText);
  check("the form shows the running total against the payment", /900\.00 · must be ฿?970/.test(recon.replace(/,/g, "")) || /must be/.test(recon), recon);
  await page.$eval(".js-add-transfer-submit", (b) => b.click());
  await page.waitForSelector(`${MT} .pay-drift`, { timeout: 15000 });
  const refusal = await page.$eval(`${MT} .pay-drift`, (x) => x.innerText);
  check("a wrong total is refused with the reason, and nothing is recorded", /add up to 900\.00, not the 970\.00/.test(refusal) && (await prisma.guidePaymentTransfer.count()) === 0, refusal);

  // 3. correct it
  await setField(page, "amount", "870");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "missing-transfer-form.png"), fullPage: true });
  await page.$eval(".js-add-transfer-submit", (b) => b.click());
  await page.waitForSelector(".js-payment-transfers", { timeout: 20000 });
  await pause(500);
  const after = await prisma.guidePayment.findUniqueOrThrow({ where: { id: data.p.id }, include: { transfers: { orderBy: { seq: "asc" } }, jobs: true } });
  check("the payment is now ฿100 + ฿870, each with its own reference",
    JSON.stringify(after.transfers.map((x) => [x.seq, Number(x.amount), x.bankRef, !!x.slipUrl])) === JSON.stringify([[1, 100, "BANK-E2E-ONE", true], [2, 870, "BANK-E2E-TWO", true]]),
    JSON.stringify(after.transfers.map((x) => [x.seq, Number(x.amount), x.bankRef])));
  check("what was paid is unchanged — total, date, the job's fee, tax and amount",
    Number(after.amountTransferred) === 970 && after.paymentDate === TODAY && Number(after.jobs[0].feeGross) === 1000 && Number(after.jobs[0].wht) === 30 && Number(after.jobs[0].payable) === 970 && after.status === "RECORDED");
  const listed = await page.$eval(".js-payment-transfers", (x) => x.innerText);
  check("the payment page lists both transfers", /Paid in 2 transfers/i.test(listed) && /BANK-E2E-TWO/.test(listed), listed.replace(/\s+/g, " ").slice(0, 200));
  check("the button is gone once the payment has its transfers", !(await page.$(".js-add-missing-transfer")));
  const audit = await prisma.auditLog.findFirst({ where: { action: "payment.transfers_added" } });
  check("the correction is audited with who and why", audit?.actorId === data.admin.id && audit?.detail?.reason === "first transfer was 100, not 970 (example)");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "missing-transfer-done.png"), fullPage: true });
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
