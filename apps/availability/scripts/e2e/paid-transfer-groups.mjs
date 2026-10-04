// Payments → Paid, "Put N jobs paid … in PEAK · 1 document", in a real browser.
//
// One transfer is one PEAK document (owner rule). Proves the buttons are one per TRANSFER:
//   1. two recorded payments made the same day are two buttons, each naming its FOLK-PMT
//   2. jobs paid before payments were recorded, the same day with different slips, are a
//      button each — not one button the server would then refuse
//   3. the server refuses to put jobs from two recorded payments in one document
// Nothing reaches PEAK: the check stops at the server's refusal and at reading the buttons.
//
// Run after `next build`:  node scripts/e2e/paid-transfer-groups.mjs
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
const PORT = Number(process.env.E2E_PORT ?? 3985);
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
const G = "G-952";
const MONTH = "2026-01";
const job = (n) => ({ jobNo: `FOLK-BKK-202601${String(n).padStart(2, "0")}-01`, date: `2026-01-${String(n).padStart(2, "0")}`, slotIdx: 0 });
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentSupplementLine", "SupplementalPayment", "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const admin = await prisma.user.create({ data: { email: "admin@example.test", displayName: "Malee Testsuite", fullName: "Malee Testsuite", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g952@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  for (const n of [4, 5, 6, 7, 8, 9]) {
    const j = job(n);
    await prisma.assignment.create({ data: { guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: j.jobNo, guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], approvalStatus: "APPROVED", approvedAt: new Date("2026-01-10T01:00:00Z"), approvedBy: admin.id,
      guideFee: { price: 1500, time: 1, whtPct: 3 }, expenses: [] } });
  }
  // Paid before payments were recorded: the same day, two different slips.
  for (const [n, slip] of [[8, "https://drive.google.com/file/d/slipE2EAAAAAAAA/view"], [9, "https://drive.google.com/file/d/slipE2EBBBBBBBB/view"]]) {
    const j = job(n);
    await prisma.tourPayment.create({ data: { guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date("2026-01-10T05:00:00Z"), eslipUrl: slip } });
  }
  return { admin };
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
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1400 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.admin.email));
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });

  // Two transfers the same day, recorded through the real endpoint (dated in the past: no notice).
  const record = (jobs, amount) => page.evaluate(async (jobs, amount) => {
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ guideId: "G-952", jobs, paymentDate: "2026-01-10", amountTransferred: amount, noSlipReason: "paid in cash at the office (example)" }));
    const r = await fetch("/api/guide-payments", { method: "POST", body: fd });
    return { status: r.status, body: await r.json() };
  }, jobs, amount);
  const p1 = await record([job(5), job(6)], 2910);
  const p2 = await record([job(7)], 1455);
  check("two transfers recorded the same day", p1.status === 200 && p2.status === 200, JSON.stringify([p1.status, p2.status, p1.body.reasons, p2.body.reasons]));

  // The month, then the guide's paid row.
  await page.evaluate((m) => {
    const el = document.querySelector('input[type="month"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, m); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, MONTH);
  await pause(1500);
  await page.evaluate(() => { const tr = [...document.querySelectorAll("tr")].find((t) => /G-952/.test(t.innerText) && /\bPAID\b/.test(t.innerText) && !/Total/.test(t.innerText)); tr?.click(); });
  await pause(800);
  const buttons = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /in PEAK · 1 document/.test(t)));
  const pmt = buttons.filter((t) => /FOLK-PMT-202601-00[12]/.test(t));
  check("1 · two recorded payments the same day are two buttons, each naming its payment",
    pmt.length === 2 && pmt.some((t) => /^Put 2 jobs .*FOLK-PMT-202601-001/.test(t)) && pmt.some((t) => /^Put 1 job .*FOLK-PMT-202601-002/.test(t)), JSON.stringify(buttons));
  const legacy = buttons.filter((t) => /FOLK-BKK-2026010[89]-01/.test(t));
  check("2 · old-style jobs paid the same day with different slips are a button each", legacy.length === 2 && legacy.every((t) => /^Put 1 job /.test(t)), JSON.stringify(buttons));
  check("no other button offers them together", buttons.length === 4, JSON.stringify(buttons));

  // 3 — the server's own rule, asked directly: jobs from both payments in one document.
  const refused = await page.evaluate(async (jobs) => {
    const r = await fetch("/api/pay/peak-document/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: "G-952", jobs, alreadyPaid: true }) });
    return { status: r.status, text: await r.text() };
  }, [job(5), job(7)].map((j) => ({ date: j.date, slotIdx: j.slotIdx })));
  check("3 · the server refuses jobs from two recorded payments in one document", /2 different recorded payments/.test(refused.text), `${refused.status} ${refused.text.slice(0, 240)}`);
  check("nothing was created in PEAK", (await prisma.guidePaymentDocument.count()) === 0 && !/peakaccount|peak\.co/i.test(readFileSync(OUTBOUND, "utf8")));
  // 4 — one payment made in two bank transfers, through the Record payment dialog (job 4, unpaid).
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await page.evaluate((m) => {
    const el = document.querySelector('input[type="month"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, m); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, MONTH);
  await pause(1500);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Record payment · 1 unpaid/.test(b.textContent.trim()))?.click()
    ?? [...document.querySelectorAll("tr")].find((t) => /G-952/.test(t.innerText) && /PENDING|Pending/.test(t.innerText))?.click());
  await pause(600);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Record payment · 1 unpaid/.test(b.textContent.trim()))?.click());
  await page.waitForSelector(".js-split-transfers", { timeout: 15000 });
  const memo = await page.$eval(".modal .js-bank-memo code", (x) => x.innerText).catch(() => "");
  check("4 · Record payment shows the bank memo for the job, before the transfer", memo === "PAY FOLK-BKK-20260104-01", memo);
  await page.click(".js-split-transfers");
  const typeIn = (name, v) => page.evaluate((name, v) => {
    const el = document.querySelector(`.modal [name="${name}"]`);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, name, v);
  await typeIn("part-date-0", "2026-01-10"); await typeIn("part-amount-0", "100"); await typeIn("part-ref-0", "BANK-E2E-P1");
  await typeIn("part-date-1", "2026-01-11"); await typeIn("part-amount-1", "1355"); await typeIn("part-ref-1", "BANK-E2E-P2");
  await pause(300);
  const totalText = await page.$eval(".js-parts-total", (x) => x.innerText);
  const amountField = await page.$eval(".modal input[inputmode=decimal]:not([name])", (x) => x.value).catch(() => "");
  check("4 · two transfers add up to the job's ฿1,455, dated the last one", /฿1,455\.00/.test(totalText) && /2026-01-11/.test(totalText) && amountField === "1455.00", `${totalText} | ${amountField}`);
  await page.evaluate(() => { const el = [...document.querySelectorAll(".modal input")].find((x) => x.placeholder?.startsWith("e.g. cash paid")); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "slips to follow (example)"); el.dispatchEvent(new Event("input", { bubbles: true })); });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "record-payment-two-transfers.png"), fullPage: true });
  await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => /^Review ·/.test(b.textContent.trim())).click());
  await page.waitForSelector(".js-review-parts", { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => /^Record payment ·/.test(b.textContent.trim())).click());
  await page.waitForFunction(() => /Payment recorded/.test(document.body.innerText), { timeout: 20000 }).catch(() => {});
  const split = await prisma.guidePayment.findFirst({ where: { transfers: { some: {} } }, include: { transfers: { orderBy: { seq: "asc" } } } });
  check("4 · recorded as ONE payment of ฿1,455 dated 11 Jan, with both transfers kept",
    !!split && Number(split.amountTransferred) === 1455 && split.paymentDate === "2026-01-11" && split.transfers.map((x) => `${Number(x.amount)}@${x.transferDate}#${x.bankRef}`).join() === "100@2026-01-10#BANK-E2E-P1,1355@2026-01-11#BANK-E2E-P2",
    JSON.stringify(split && { a: Number(split.amountTransferred), d: split.paymentDate, t: split.transfers.length }));
  // 5 — the slip on a recorded payment's tag opens the slip (it was plain text: "· slip" could not be clicked).
  const SLIP_LINK = "https://drive.google.com/file/d/slipE2ECCCCCCCC/view";
  await prisma.guidePayment.updateMany({ where: { paymentNo: "FOLK-PMT-202601-001" }, data: { slipUrl: SLIP_LINK } });
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await page.evaluate((m) => {
    const el = document.querySelector('input[type="month"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, m); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, MONTH);
  await pause(1500);
  await page.evaluate(() => { const tr = [...document.querySelectorAll("tr")].find((t) => /G-952/.test(t.innerText) && /\bPAID\b/.test(t.innerText) && !/Total/.test(t.innerText)); tr?.click(); });
  await page.waitForSelector(".js-pmt-slip", { timeout: 15000 }).catch(() => {});
  const links = await page.$$eval(".js-pmt-slip", (as) => as.map((a) => ({ href: a.href, target: a.target, chip: a.closest(".pay-pmt")?.innerText })));
  check("5 · a recorded payment's slip opens from its tag, in a new tab", links.length === 2 && links.every((l) => l.href === SLIP_LINK && l.target === "_blank" && /FOLK-PMT-202601-001 · slip/.test(l.chip)), JSON.stringify(links));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "payment-chip-slip.png"), fullPage: true });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "paid-transfer-groups.png"), fullPage: true });
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\npaid transfer groups e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
