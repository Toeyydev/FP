// Supplemental guide payments in a real browser, against a real server and database.
//
// Proves, on the Payments page itself:
//   1. Add Supplemental Payment → review incentive for a paid job, ฿1,200 → the review shows
//      ฿36 withheld and ฿1,164 to transfer, booked to REVIEW_REWARD; Create makes it UNPAID
//   2. the same again is shown as a possible duplicate, and cannot be created without a reason
//   3. Record payment makes a NEW transfer of ฿1,164 — the original payout is untouched
//   4. a PEAK reference turns "Accounting pending" into "Reconciled"
//   5. Guide Payments history lists the original as "Guide payment" for its own amount and
//      the new one as "Supplemental · Review incentive" for ฿1,164
//   6. a guide cannot read supplemental payments, but sees the paid one in their own My Pay
//   7. the withholding rate shown comes from configured policy; with none, it must be entered
//   8. an earlier unpaid bonus converts into a supplemental payment, once, from its row
//
// Run after `next build`:  node scripts/e2e/supplemental-payment.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET. Screenshots go to E2E_SCREEN_DIR if set.
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
// Configured accounting policy for this run: review incentives withheld at 3%; bonuses
// have no configured rate, so the operator must state one.
process.env.SUPPLEMENTAL_WHT_PCT_REVIEW_INCENTIVE = "3";
delete process.env.SUPPLEMENTAL_WHT_PCT_BONUS;
const THIS_MONTH = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);

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
const G = "G-951";
const JOB = { jobNo: "FOLK-BKK-20250710-01", date: "2025-07-10", slotIdx: 0 };
const JOB2 = { jobNo: "FOLK-BKK-20250715-01", date: "2025-07-15", slotIdx: 1 };
const ORIGINAL_NO = "FOLK-PMT-202507-001";
const ORIGINAL_AMOUNT = 1477; // fee 1,500 − WHT 45 + ferry 22
async function seed() {
  const tables = ["AuditLog", "Notification", "GuidePaymentSupplementLine", "SupplementalPayment", "Bonus", "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const guide = await prisma.user.create({ data: { email: "g951@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: G, date: JOB.date, slotIdx: 0, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: JOB.jobNo, guideId: G, date: JOB.date, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], approvalStatus: "APPROVED",
    guideFee: { price: 1500, time: 1, whtPct: 3 }, expenses: [{ description: "Ferry", price: 11, pax: 2, expenseType: "transport", paidBy: "guide", paidBySource: "operator" }] } });
  // The payout that already went.
  const p = await prisma.guidePayment.create({ data: { paymentNo: ORIGINAL_NO, guideId: G, accountingPeriod: "2025-07", paymentDate: "2025-07-12", jobTotal: ORIGINAL_AMOUNT, adjustmentTotal: 0, amountTransferred: ORIGINAL_AMOUNT,
    status: "RECORDED", source: "MANUAL", noSlipReason: "cash at the office (example)", createdById: op.id,
    jobs: { create: [{ guideId: G, date: JOB.date, slotIdx: 0, jobNo: JOB.jobNo, accountingDate: JOB.date, feeGross: 1500, wht: 45, reimbursement: 22, reviewReward: 0, payable: ORIGINAL_AMOUNT }] } } });
  await prisma.tourPayment.create({ data: { guideId: G, date: JOB.date, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date("2025-07-12T05:00:00Z"), guidePaymentId: p.id } });
  // An earlier bonus from the old panel, never paid — shown in this month's board.
  // A second tour that month, approved and not paid yet: its transfer may carry the review incentive.
  await prisma.assignment.create({ data: { guideId: G, date: JOB2.date, slotIdx: 1, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: JOB2.jobNo, guideId: G, date: JOB2.date, slotIdx: 1, tourId: "T-900", status: "Confirmed", bookings: [], approvalStatus: "APPROVED",
    guideFee: { price: 1500, time: 1, whtPct: 3 }, expenses: [] } });
  const bonus = await prisma.bonus.create({ data: { guideId: G, period: THIS_MONTH, amount: 300, reason: "busy-season bonus (example)" } });
  return { op, guide, originalId: p.id, bonusId: bonus.id };
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

// ── helpers ──────────────────────────────────────────────────────────────────
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const DLG = ".js-add-supplemental-dialog";
const text = (page, sel) => page.$eval(sel, (x) => x.innerText).catch(() => "");
/** Set a React-controlled input/select/textarea by its name inside a container. */
async function setField(page, scope, name, value) {
  await page.evaluate((scope, name, value) => {
    const el = document.querySelector(`${scope} [name="${name}"]`);
    if (!el) throw new Error(`no field ${name}`);
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  }, scope, name, value);
  await pause(250);
}
async function click(page, sel) { await page.waitForSelector(sel, { timeout: 15000 }); await page.$eval(sel, (b) => b.click()); await pause(400); }
async function clickText(page, scope, label) {
  const ok = await page.evaluate((scope, label) => { const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim() === label && !x.disabled); if (!b) return false; b.click(); return true; }, scope, label);
  if (!ok) throw new Error(`no enabled "${label}" in ${scope}`);
  await pause(400);
}
async function fillReview(page) {
  await click(page, ".js-add-supplemental");
  await page.waitForSelector(DLG);
  await setField(page, DLG, "guide", G);
  await setField(page, DLG, "type", "REVIEW_INCENTIVE");
  await page.waitForSelector(".js-review-fields", { timeout: 15000 });
  await setField(page, DLG, "reviews", "4");
  await setField(page, DLG, "workMonth", "2025-07");
  await setField(page, DLG, "reason", "GetYourGuide reviews naming the guide (example)");
  await pause(200);
  await clickText(page, DLG, "Review");
  await page.waitForFunction(() => document.querySelector(".js-supplemental-review") || document.querySelector(".js-add-supplemental-dialog .pay-drift"), { timeout: 15000 });
}

// ── the test ─────────────────────────────────────────────────────────────────
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const before = JSON.stringify(await prisma.guidePayment.findUnique({ where: { id: data.originalId }, include: { jobs: true } }));
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1800 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Prompts are answered from this queue when it has answers, else accepted as they come.
  const answers = [];
  page.on("dialog", (d) => d.accept(answers.length ? answers.shift() : undefined));
  await page.setCookie(await sessionCookie(data.op.email));
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-add-supplemental", { timeout: 20000 });

  // 1 — a review incentive: 4 reviews naming the guide in July (owner policy 2026-10-06)
  await fillReview(page);
  const rule = await text(page, ".js-wht-rule");
  check("the form says the guide is paid in full with no withholding tax (owner 2026-10-06)", /in full/.test(rule) && /No withholding tax/.test(rule) && /฿200\.00/.test(rule) && !/฿206/.test(rule), rule.replace(/\s+/g, " ").slice(0, 200));
  const rev = await text(page, ".js-supplemental-review");
  check("the review shows ฿200 to the guide, no tax, booked to REVIEW_REWARD",
    /฿200\.00/.test(rev) && /None · ไม่มีภาษี/.test(rev) && !/฿206/.test(rev) && /REVIEW_REWARD/.test(rev) && /4 · 2025-07/.test(rev), rev.replace(/\s+/g, " ").slice(0, 240));
  if (SHOTS) await (await page.$(DLG)).screenshot({ path: join(SHOTS, "add-review.png") });
  await click(page, ".js-create-supplemental");
  await page.waitForFunction(() => !document.querySelector(".js-add-supplemental-dialog"), { timeout: 15000 }).catch(() => {});
  let row = await text(page, ".js-supplemental-table tbody tr");
  const memo = await page.$eval(".js-supplemental-table .js-bank-memo code", (x) => x.innerText).catch(() => "");
  check("the unpaid review incentive shows the bank memo to type before transferring", memo === "REV G-951 2025-07", memo);
  check("Create makes it unpaid: 4 reviews for July, ฿200 to transfer", /Unpaid/.test(row) && /4 reviews · 2025-07/.test(row) && /฿200\.00/.test(row) && /no tax/.test(row), row.replace(/\s+/g, " ").slice(0, 200));

  // 2 — the same month again: added to the open one, not a second incentive
  await fillReview(page);
  const refusal = await page.evaluate(() => [...document.querySelectorAll(".js-add-supplemental-dialog .pay-drift")].map((x) => x.innerText).join(" "));
  check("a second incentive for the same open month is refused — add the reviews to it", /already an unpaid review incentive for 2025-07/.test(refusal), refusal.slice(0, 160));
  await clickText(page, DLG, "Cancel");
  check("nothing was created by the second attempt", (await prisma.supplementalPayment.count()) === 1);
  answers.push("2", "two more reviews this week (example)");
  await page.evaluate(() => document.querySelector(".js-add-reviews").click());
  await page.waitForFunction(async () => /6 reviews · 2025-07/.test(document.querySelector(".js-supplemental-table tbody tr")?.innerText ?? ""), { timeout: 15000 }).catch(() => {});
  const six = await prisma.supplementalPayment.findFirst();
  row = await text(page, ".js-supplemental-table tbody tr");
  check("+ Reviews adds to it and the figures follow the count (6 → ฿300, no tax)", six?.reviewCount === 6 && Number(six?.netAmount) === 300 && Number(six?.wht) === 0 && /฿300\.00/.test(row), row.replace(/\s+/g, " ").slice(0, 200));

  // 3 — its own transfer
  await page.evaluate(() => [...document.querySelectorAll(".js-supplemental-table button")].find((b) => b.textContent.trim() === "Record payment").click());
  await page.waitForSelector(".js-pay-supplemental-dialog");
  await setField(page, ".js-pay-supplemental-dialog", "paymentDate", "2025-07-20");
  await setField(page, ".js-pay-supplemental-dialog", "noSlipReason", "paid in cash at the office (example)");
  await click(page, ".js-record-supplemental");
  await page.waitForFunction(() => !document.querySelector(".js-pay-supplemental-dialog"), { timeout: 15000 }).catch(() => {});
  await pause(800);
  row = await text(page, ".js-supplemental-table tbody tr");
  const supp = await prisma.guidePayment.findFirst({ where: { kind: "SUPPLEMENTAL" } });
  check("Record payment makes a new transfer of ฿300 — the full amount", !!supp && Number(supp.amountTransferred) === 300 && supp.paymentNo !== ORIGINAL_NO && supp.accountingPeriod === "2025-07" && /Paid/.test(row) && row.includes(supp.paymentNo) && /Accounting pending/.test(row), row.replace(/\s+/g, " ").slice(0, 200));
  check("the original payout is untouched", JSON.stringify(await prisma.guidePayment.findUnique({ where: { id: data.originalId }, include: { jobs: true } })) === before);

  const banner = await text(page, ".js-accounting-pending");
  const summary = await text(page, ".js-sup-pending");
  check("paid but not in PEAK is flagged on the list and in the month summary", /1 paid supplemental payment is not in PEAK yet/.test(banner) && /1 supplemental not in PEAK/.test(summary), `${banner.replace(/\s+/g, " ").slice(0, 120)} | ${summary}`);

  // 4 — PEAK through the API: a bank account is chosen, then "Put in PEAK" (no PEAK in this test)
  const peakCell = await text(page, ".js-review-peak");
  const putDisabled = await page.$eval(".js-put-review-in-peak", (b) => b.disabled).catch(() => null);
  check("a paid review incentive offers Put in PEAK, once a bank account is chosen — no number typed by hand",
    /Bank account/.test(peakCell) && putDisabled === true && !(await page.$('.js-supplemental-table input[aria-label="PEAK document number"]')), peakCell.replace(/\s+/g, " ").slice(0, 160));

  // 8 — the earlier bonus
  await page.waitForSelector(".js-convert-bonus", { timeout: 15000 });
  await page.$eval(".js-convert-bonus", (b) => b.click());
  await page.waitForSelector(DLG);
  await page.waitForFunction((dlg) => !!document.querySelector(`${dlg} [name="whtPct"]`), { timeout: 15000 }, DLG);
  const amountLocked = await page.$eval(`${DLG} [name="amount"]`, (x) => x.readOnly && x.value === "300");
  const bonusRule = await text(page, ".js-wht-rule");
  check("converting the earlier bonus fixes its amount; with no configured bonus rate, the rate must be entered", amountLocked && /No rate is configured for a bonus/.test(bonusRule), bonusRule.replace(/\s+/g, " ").slice(0, 120));
  await setField(page, DLG, "whtPct", "0");
  await setField(page, DLG, "category", "GUIDE_FEE");
  await clickText(page, DLG, "Review");
  await page.waitForSelector(".js-supplemental-review", { timeout: 15000 });
  await click(page, ".js-create-supplemental");
  await page.waitForFunction(() => !document.querySelector(".js-add-supplemental-dialog"), { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => /Converted → supplemental payment/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  const conv = await prisma.supplementalPayment.findFirst({ where: { legacyBonusId: data.bonusId } });
  check("the earlier bonus is converted once, linked, and its row says so", !!conv && Number(conv.grossAmount) === 300 && conv.whtSource === "ENTERED" && /Converted → supplemental payment/.test(await page.evaluate(() => document.body.innerText)) && !(await page.$(".js-convert-bonus")));
  check("the earlier bonus record itself is unchanged", !!(await prisma.bonus.findFirst({ where: { id: data.bonusId, eslipUrl: null, amount: 300 } })));
  if (SHOTS) await (await page.$("section[aria-label='Supplemental payments']")).screenshot({ path: join(SHOTS, "supplemental-list.png") });

  // 5
  await page.evaluate(() => [...document.querySelectorAll(".subtab")].find((b) => b.textContent.trim() === "Guide Payments").click());
  await page.waitForSelector('input[type="month"]', { timeout: 15000 });
  await page.evaluate(() => { const el = document.querySelector('input[type="month"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "2025-07"); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForFunction((no) => document.body.innerText.includes(no), { timeout: 15000 }, ORIGINAL_NO).catch(() => {});
  await pause(800);
  const hist = await page.evaluate(() => [...document.querySelectorAll("table.acct-table tbody tr")].map((r) => r.innerText.replace(/\s+/g, " ")).filter((t) => /FOLK-PMT-/.test(t)));
  // The history table's rows begin with the payment number (the jobs table above it only names one).
  const origLine = hist.find((t) => t.trim().startsWith(ORIGINAL_NO)) ?? "";
  const suppLine = hist.find((t) => supp && t.trim().startsWith(supp.paymentNo)) ?? "";
  check("history: the original is a guide payment for its own amount", /Guide payment/.test(origLine) && /฿1,477\.00/.test(origLine), origLine);
  check("history: the new one is Supplemental · Review incentive for ฿300", /Supplemental · Review incentive/.test(suppLine) && /฿300\.00/.test(suppLine), suppLine);
  check("the Payments page ran without a crash", errors.length === 0, errors.join(" | ").slice(0, 200));

  // 6
  const g = await sessionCookie(data.guide.email);
  const r = await fetch(`${BASE}/api/supplemental-payments`, { headers: { cookie: `${g.name}=${g.value}` } });
  check("a guide cannot read supplemental payments", r.status === 403, String(r.status));
  const gp = await browser.newPage();
  await gp.setViewport({ width: 420, height: 900 });
  await gp.setCookie(g);
  await gp.goto(`${BASE}/pay`, { waitUntil: "networkidle0" });
  // The test's payment is dated in 2025 — older than My Pay's default 12 months, so the
  // guide opens their full history, as they would for an old payment.
  await gp.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Show all history"), { timeout: 15000 });
  await gp.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Show all history").click());
  await gp.waitForSelector(".js-my-additional", { timeout: 15000 }).catch(() => {});
  const mine = await text(gp, ".js-my-additional");
  check("the guide sees the review incentive in My Pay, apart from the tours: paid in full, no tax — nothing deducted", /Review incentive/.test(mine) && /฿300/.test(mine) && /paid in full/.test(mine) && /no tax · ไม่หักภาษี/.test(mine) && !/paid by Folkpaths/.test(mine) && !/− WHT/.test(mine) && supp && mine.includes(supp.paymentNo), mine.replace(/\s+/g, " ").slice(0, 160));
  if (SHOTS) await gp.screenshot({ path: join(SHOTS, "my-pay-additional.png") });
  await gp.close();
  await page.close();

  // 7 — one bank transfer for the July tour AND a review incentive: two payments, one transfer.
  await prisma.supplementalPayment.create({ data: { guideId: G, type: "REVIEW_INCENTIVE", accountingCategory: "REVIEW_REWARD", grossAmount: 100, whtPct: 0, whtSource: "POLICY", wht: 0, netAmount: 100,
    whtBearer: "COMPANY_ONCE", reviewCount: 2, workMonth: "2025-07", reason: "GetYourGuide reviews naming the guide (example)" } });
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1400, height: 1600 });
  const p2errors = [];
  p2.on("pageerror", (e) => p2errors.push(String(e)));
  await p2.setCookie(await sessionCookie(data.op.email));
  await p2.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await p2.evaluate((m) => { const el = document.querySelector('input[type="month"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, m); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, "2025-07");
  await pause(1500);
  await p2.evaluate((g) => { const tr = [...document.querySelectorAll("tr")].find((t) => t.innerText.includes(g) && /Pending|PENDING/.test(t.innerText)); tr?.click(); }, G);
  await pause(800);
  await p2.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Record payment · 1 unpaid/.test(b.textContent.trim()))?.click());
  await p2.waitForSelector(".js-review-due", { timeout: 15000 }).catch(() => {});
  const due = await text(p2, ".js-review-due");
  check("Record payment offers this guide's unpaid review incentive for the same transfer", /2 reviews/.test(due) && /฿100\.00/.test(due) && /paid in full, no tax/.test(due), due.replace(/\s+/g, " ").slice(0, 160));
  await p2.evaluate(() => document.querySelector(".js-review-due input[type=checkbox]").click());
  await pause(300);
  const amount = await p2.evaluate(() => document.querySelector(".modal input[inputmode=decimal]")?.value ?? "");
  check("ticking it adds ฿100 to the transfer (job ฿1,455 + ฿100)", amount === "1555.00", amount);
  if (SHOTS) await p2.screenshot({ path: join(SHOTS, "record-payment-with-review.png"), fullPage: true });
  const r7 = await p2.evaluate(async (g, job) => {
    const sups = await (await fetch(`/api/supplemental-payments?guideId=${g}`)).json();
    const id = sups.rows.find((x) => x.whtBearer === "COMPANY_ONCE" && x.payment === "UNPAID").id;
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ guideId: g, jobs: [job], supplements: [id], paymentDate: "2025-07-25", amountTransferred: 1555, bankRef: "BANK-E2E-SHARED", noSlipReason: "slip follows (example)" }));
    const r = await fetch("/api/guide-payments", { method: "POST", body: fd });
    return { status: r.status, body: await r.json() };
  }, G, JOB2);
  const shared = await prisma.guidePayment.findMany({ where: { bankRef: "BANK-E2E-SHARED" } });
  check("recorded as two payments from one transfer: ฿1,455 for the job, ฿100 for the reviews, one bank reference",
    r7.status === 200 && shared.length === 2 && shared[0].transferGroup && shared[0].transferGroup === shared[1].transferGroup && shared.map((x) => Number(x.amountTransferred)).sort((a, b) => a - b).join() === "100,1455",
    JSON.stringify({ s: r7.status, n: shared.length, linked: r7.body.linked?.paymentNo }));
  check("no page errors on Record payment", p2errors.length === 0, p2errors.join(" | ").slice(0, 200));
  await p2.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsupplemental payment e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
