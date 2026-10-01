// Advance settlement Phase 1B, in a real browser (lib/advances/settlement):
//   1. the job sheet shows the advance's status from the ledger, and its card offers the rows
//      confirmed as paid from it for settling — nothing about tagged-but-unlinked rows
//   2. settling the ticked rows settles exactly those (server-computed amount), the card updates
//   3. a row marked Company Advance that is not linked is shown as awaiting, not settleable
//   4. the settled row cannot then be changed by a save
// All data invented. Run after `next build`:  node scripts/e2e/advance-settlement.mjs
// (Shared scaffolding below, as in the other browser suites:)
//
//   1. a payer the booked Rate suggested reads "… · awaiting confirmation", never as confirmed
//   2. Confirm payer + Save records the operator's confirmation (stamped); the rest stay defaults
//   3. guests on different Rates → the ticket row asks a person to choose
//   4. the accountant's "costs still to be booked" list keeps a suggested Company Resource
//      out of its totals, in an "awaiting payer confirmation" bucket
// All data invented. Run after `next build`:  node scripts/e2e/rate-payer.mjs
// The historical evidence page in a real browser, against a real server and database.
//
// Proves, on the job sheet page itself:
//   1. an approved sheet shows the approval block (status, approver, time) to an operator
//      and an admin, and prints it
//   2. neither sees the old certification: the statement, CERTIFIED BY, a signature image,
//      a certifier name or a date under a signature
//   3. an admin sees the certificate in lieu of receipt by number with its Drive link; an
//      operator sees nothing about it (certificates are admin-only)
//   4. a sheet that needs a certificate but has none says how to make one, and opening the
//      page creates nothing
//
// Run after `next build`:  node scripts/e2e/jobsheet-approval.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET. Screenshots go to E2E_SCREEN_DIR if set.
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
const PORT = Number(process.env.E2E_PORT ?? 3996);
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

// ── data (invented) ──────────────────────────────────────────────────────────
const DATE = "2099-07-15";
async function seed() {
  const tables = ["AuditLog", "Notification", "AdvancePeakSync", "GuideAdvanceEntry", "GuideAdvanceRefund", "GuideAdvanceReceipt", "GuideAdvance", "ExpenseCertificate", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op-adv@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g992@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: "G-992", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.assignment.create({ data: { guideId: "G-992", date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
  const adv = await prisma.guideAdvance.create({ data: { guideId: "G-992", date: DATE, slotIdx: 0, amount: 1000, paidAt: new Date(), method: "bank", txRef: "TX-E2E-1", advanceNo: "FOLK-ADV-209907-001", advanceDate: "2099-07-14", amountSatang: 100000, accountingPeriod: "2099-07", allowedCategories: ["entrance"] } });
  const confirmed = { paidBy: "advance", paidBySource: "guide" };
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-ADV-E2E-01", guideId: "G-992", date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: [
      { description: "Grand Palace", expenseType: "entrance", price: 500, pax: 1, ...confirmed, advanceId: adv.id },
      { description: "Wat Pho", expenseType: "entrance", price: 100, pax: 2, ...confirmed, advanceId: adv.id },
      { description: "Wat Arun", expenseType: "entrance", price: 100, pax: 1, paidBy: "advance", paidBySource: "rate-default" },
    ] } });
  return { op, adv };
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const text = (page, sel) => page.$eval(sel, (x) => x.innerText).catch(() => "");
const rows = async () => (await prisma.jobSheet.findFirstOrThrow({ where: { guideId: "G-992" } })).expenses;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setCookie(await sessionCookie(data.op.email));
  await page.goto(`${BASE}/job-sheet?guideId=G-992&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
  // Phase 1D: settling happens on the advance's own card (components/AdvanceOperations) — the
  // operator ticks the rows linked to it; the server still works out the amount.
  const CARD = '.js-adv-card[data-advance="FOLK-ADV-209907-001"]';
  await page.waitForSelector(`${CARD} .js-adv-pick`, { timeout: 20000 });
  for (const box of await page.$$(`${CARD} .js-adv-pick`)) await box.click();
  const label = await text(page, `${CARD} .js-adv-settle`);
  check("the settle button names the linked rows' total and the advance (Grand Palace 500 + Wat Pho 200)", /Settle selected \(฿700(\.00)?\) to FOLK-ADV-209907-001/.test(label), label);
  check("the unlinked Rate-suggested row is shown as awaiting, not settleable", /not settleable yet[\s\S]*฿100(\.00)?/.test(await text(page, ".js-advance-awaiting")), await text(page, ".js-advance-awaiting"));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "advance-before.png"), fullPage: true });
  await page.click(`${CARD} .js-adv-settle`);
  await pause(2500);
  const entries = await prisma.guideAdvanceEntry.findMany({ where: { advanceId: data.adv.id } });
  check("pressing it settles exactly those rows: one entry of ฿700 with two lines", entries.length === 1 && entries[0].amountSatang === 70000 && entries[0].snapshot?.lines?.length === 2, JSON.stringify(entries.map((e) => e.amountSatang)));
  const r = await rows();
  check("the two rows are marked settled; the unlinked row is not", !!r[0].advanceSettlement && !!r[1].advanceSettlement && !r[2].advanceSettlement);
  check("the button is gone once nothing is left to settle", (await page.$(`${CARD} .js-adv-settle`)) === null);
  const card = await text(page, CARD);
  check("the panel reads the ledger: return due, ฿300 outstanding", /Return due/i.test(card) && /Outstanding ฿300(\.00)?/.test(card), card.slice(0, 200));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "advance-after.png"), fullPage: true });
  // A save that changes the settled row is refused, and says why.
  const save = await page.evaluate(async (date) => {
    const g = await (await fetch(`/api/jobsheet?guideId=G-992&date=${date}&slotIdx=0`)).json();
    const ex = g.sheet.expenses.map((e, i) => (i === 0 ? { ...e, pax: 2 } : e));
    const r = await fetch("/api/jobsheet", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: "G-992", date, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: g.sheet.bookings, expenses: ex, guideFee: g.sheet.guideFee, baseUpdatedAt: g.sheet.updatedAt }) });
    return { status: r.status, body: await r.json() };
  }, DATE);
  check("changing a settled row's amount is refused, naming the settlement", save.status === 409 && /settlement of company advance FOLK-ADV-209907-001/.test((save.body.reasons ?? []).join(" ")), JSON.stringify(save).slice(0, 200));
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nadvance settlement e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
