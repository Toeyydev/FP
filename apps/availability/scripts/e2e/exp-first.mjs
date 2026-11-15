// Payments, EXP first, in a real browser (owner 2026-11-15):
//   1. an unpaid guide row offers "Create PEAK EXP · N" as THE action; the synthetic
//      "PAY G-… dates" memo is gone; recording without an EXP is a secondary "Record without PEAK EXP…"
//   2. an EXP waiting for its transfer is a card led by the EXP number (Copy), with four
//      separate states; after a failed PEAK payment the button is "Retry PEAK payment"
//   3. the payments list leads with the EXP; FOLK-PMT is small beside it
//   4. no sideways page scroll at 390 px; nothing reaches PEAK
// Run after `next build`:  node scripts/e2e/exp-first.mjs   All data invented.

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
const PORT = Number(process.env.E2E_PORT ?? 3991);
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
  const tables = ["AuditLog", "Notification", "GuidePaymentTransfer", "GuidePaymentSupplementLine", "SupplementalPayment", "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const admin = await prisma.user.create({ data: { email: "admin-exp@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  for (const g of ["G-953", "G-954", "G-955"]) await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: `Guide ${g}`, fullName: `Guide ${g}`, guideId: g, role: "GUIDE", state: "ACTIVE", passwordHash: hash, peakContactId: `contact-${g}` } });
  const sheet = (g, d) => prisma.jobSheet.create({ data: { ref: `FOLK-BKK-202601${d}-01`, guideId: g, date: `2026-01-${d}`, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], approvalStatus: "APPROVED", approvedAt: new Date("2026-01-10T01:00:00Z"), approvedBy: admin.id, guideFee: { price: 1500, time: 1, whtPct: 3 }, expenses: [] } });
  for (const [g, d] of [["G-953", "04"], ["G-953", "05"], ["G-954", "06"], ["G-955", "07"]]) {
    await prisma.assignment.create({ data: { guideId: g, date: `2026-01-${d}`, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await sheet(g, d);
  }
  // G-954: an EXP created and waiting; its last PEAK payment attempt was refused.
  await prisma.guidePaymentDocument.create({ data: { paymentRef: "FOLK-PAY-202601-01", guideId: "G-954", jobs: [{ date: "2026-01-06", slotIdx: 0, ref: "FOLK-BKK-20260106-01", payout: 1455 }], lines: [{ date: "2026-01-06", slotIdx: 0, jobRef: "FOLK-BKK-20260106-01", kind: "GUIDE_FEE", price: 1500, wht: 45 }], total: 1455, status: "AWAITING_PAYMENT",
    peakDocumentId: "doc-e2e-31", peakDocumentNo: "EXP-20260100031", error: "PEAK refused: payment method not found", peakPostedAt: new Date("2026-01-10T02:00:00Z") } });
  await prisma.tourPayment.create({ data: { guideId: "G-954", date: "2026-01-06", slotIdx: 0, tourId: "T-900", status: "PENDING", peakPaymentRef: "FOLK-PAY-202601-01" } });
  // G-955: paid, its job carries its EXP.
  const pay = await prisma.guidePayment.create({ data: { paymentNo: "FOLK-PMT-202601-007", guideId: "G-955", accountingPeriod: "2026-01", paymentDate: "2026-01-10", jobTotal: 1455, adjustmentTotal: 0, amountTransferred: 1455, noSlipReason: "example" } });
  await prisma.guidePaymentJob.create({ data: { paymentId: pay.id, guideId: "G-955", date: "2026-01-07", slotIdx: 0, jobNo: "FOLK-BKK-20260107-01", accountingDate: "2026-01-07", feeGross: 1500, wht: 45, reimbursement: 0, reviewReward: 0, payable: 1455, peakDocumentNo: "EXP-20260100020", peakSource: "combined" } });
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
const setMonth = (page) => page.evaluate((m) => {
  const el = document.querySelector('input[type="month"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(el, m); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
}, "2026-01");
const expand = (page, g) => page.evaluate((g) => { const tr = [...document.querySelectorAll("tr")].find((t) => t.innerText.includes(g) && !/Total/.test(t.innerText) && t.querySelector("td")); tr?.click(); }, g);
try {
  const cookie = await sessionCookie(data.admin.email);
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1400 });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(cookie);
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await setMonth(page); await pause(1500);

  // 1 — no EXP yet
  const header = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /^Create PEAK EXP/.test(t)));
  check("1 · an unpaid guide row's action is Create PEAK EXP", header.includes("Create PEAK EXP · 2"), JSON.stringify(header));
  await expand(page, "G-953"); await pause(800);
  check("1 · expanded: Create PEAK EXP · 2 jobs", (await page.$$eval(".js-create-exp", (xs) => xs.map((x) => x.innerText.trim()))).includes("Create PEAK EXP · 2 jobs"));
  const text = await page.evaluate(() => document.body.innerText);
  check("1 · no synthetic PAY G-… memo anywhere on Payments", !/\bPAY G-\d+/.test(text), (text.match(/PAY G-[^\n]*/) ?? [""])[0]);
  check("1 · recording without an EXP is secondary and says so", (await page.$$eval(".js-record-no-exp", (xs) => xs.map((x) => `${x.className}|${x.innerText.trim()}`))).every((t) => /ghost/.test(t) && /Record without PEAK EXP/.test(t)));

  // 2 — EXP waiting, last payment refused
  await expand(page, "G-954"); await pause(1500);
  const card = await page.evaluate(() => {
    const c = document.querySelector(".js-exp-card"); if (!c) return null;
    return { no: c.querySelector(".js-exp-no")?.textContent, copy: !!c.querySelector(".js-exp-copy"), jobs: c.querySelector(".js-exp-jobs")?.textContent,
      stages: [...c.querySelectorAll("[data-stage]")].map((s) => `${s.getAttribute("data-stage")}:${s.getAttribute("data-state")}`), button: c.querySelector(".js-exp-record")?.textContent, text: c.innerText };
  });
  check("2 · the card is led by the EXP number, with Copy", card?.no === "EXP-20260100031" && card?.copy, JSON.stringify(card?.no));
  check("2 · it lists the job and the guide", /FOLK-BKK-20260106-01/.test(card?.jobs ?? "") && /G-954/.test(card?.text ?? ""), card?.jobs);
  check("2 · four separate states; the PEAK payment is the problem", JSON.stringify(card?.stages?.map((s) => s.split(":")[0])) === JSON.stringify(["CREATED", "APPROVED", "TRANSFER", "PEAK_PAYMENT"]) && card.stages.includes("CREATED:done") && card.stages.includes("PEAK_PAYMENT:problem") && card.stages.includes("TRANSFER:todo"), JSON.stringify(card?.stages));
  check("2 · after a refused payment the action is Retry PEAK payment, with PEAK's error", card?.button === "Retry PEAK payment" && /payment method not found/.test(card?.text ?? ""), card?.button);

  // 3 — the payments list
  await page.evaluate(() => [...document.querySelectorAll(".subtab")].find((b) => b.textContent.trim() === "Guide Payments")?.click());
  await pause(1500);
  await setMonth(page).catch(() => {}); await pause(1200);
  const refs = await page.$$eval(".js-payment-ref", (xs) => xs.map((x) => `${x.getAttribute("data-kind")}|${x.innerText.replace(/\s+/g, " ")}`));
  check("3 · the payments list leads with the EXP, FOLK-PMT beside it", refs.some((r) => /^EXP\|EXP-20260100020 FOLK-PMT-202601-007/.test(r)), JSON.stringify(refs));
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await page.close();

  // 4 — phone width, nothing to PEAK
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await phone.setCookie(cookie);
  await phone.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await setMonth(phone); await pause(1200); await expand(phone, "G-954"); await pause(1200);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("4 · no sideways page scroll at 390 px", wide <= 0, `${wide}px`);
  if (SHOTS) await phone.screenshot({ path: join(SHOTS, "exp-first-390.png"), fullPage: true });
  await phone.close();
  check("4 · nothing was sent to PEAK", !/peakaccount|peakengine/i.test(readFileSync(OUTBOUND, "utf8")) && (await prisma.guidePaymentDocument.count()) === 1);
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nEXP-first e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
