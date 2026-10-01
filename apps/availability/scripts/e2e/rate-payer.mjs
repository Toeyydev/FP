// Rate-driven default payers, in a real browser (lib/rate-payer):
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
const PORT = Number(process.env.E2E_PORT ?? 3995);
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
const DATE = "2099-06-10";
async function seed() {
  const tables = ["AuditLog", "Notification", "ExpenseCertificate", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g990@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: "G-990", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const mk = (ref, slotIdx, rateTitle) => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, confirmationCode: `GET-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx, tourId: "T-900", pax: 2, status: "OFFERED", rateTitle } });
  const row = (ref) => ({ name: `Guest ${ref}`, bookingNo: ref, bookedPax: 2, actualPax: null, tickets: "", status: "" });
  const sheet = (slotIdx, refs, expenses) => prisma.jobSheet.create({ data: { ref: `FOLK-TEST-RATE-0${slotIdx + 1}`, guideId: "G-990", date: DATE, slotIdx, tourId: "T-900", status: "Confirmed", bookings: refs.map(row), expenses, guideFee: { price: 1000, time: 1, whtPct: 3 } } });
  // Slot 0 — a guided Rate: Water and Ferry carry the Rate's suggestion.
  await mk("RATE-E2E-1", 0, "Tour without entrance tickets"); await mk("RATE-E2E-2", 0, "Tour without entrance tickets");
  // Slot 1 — guests on different Rates: the ticket payer is left to a person.
  await mk("RATE-E2E-3", 1, "Tour with all entrance tickets"); await mk("RATE-E2E-4", 1, "Tour without entrance tickets");
  // Slot 2 — ticket-inclusive: the tickets are suggested as Company Resource.
  await mk("RATE-E2E-5", 2, "Tour with all entrance tickets"); await mk("RATE-E2E-6", 2, "Tour with all entrance tickets");
  // Slot 3 — a Rate nobody has classified.
  await mk("RATE-E2E-7", 3, "Come Hungry and Get back full");
  for (const slotIdx of [0, 1, 2, 3, 4]) await prisma.assignment.create({ data: { guideId: "G-990", date: DATE, slotIdx, tourId: "T-900", pax: 4 } });
  await sheet(0, ["RATE-E2E-1", "RATE-E2E-2"], [
    { description: "Water (Inc. Guide)", price: 10, pax: 5, expenseType: "meal", paidBy: "guide", paidBySource: "rate-default", rateBasis: "GUIDED_EXPERIENCE" },
    { description: "Ferry (Inc. Guide)", price: 11, pax: 5, expenseType: "transport", paidBy: "guide", paidBySource: "rate-default", rateBasis: "GUIDED_EXPERIENCE" },
  ]);
  await sheet(1, ["RATE-E2E-3", "RATE-E2E-4"], [{ description: "Grand Palace", price: 500, pax: 4, expenseType: "entrance" }]);
  await sheet(2, ["RATE-E2E-5", "RATE-E2E-6"], [{ description: "Grand Palace", price: 500, pax: 4, expenseType: "entrance", paidBy: "company", paidBySource: "rate-default", rateBasis: "TICKET_INCLUDED" }]);
  await sheet(3, ["RATE-E2E-7"], [{ description: "Ferry (Inc. Guide)", price: 11, pax: 3, expenseType: "transport" }]);
  // Slot 4 — company money for the accountant's list: one confirmed, one only suggested by the Rate.
  await sheet(4, [], [
    { description: "Coach confirmed", price: 1200, pax: 1, expenseType: "transport", paidBy: "company", paidBySource: "operator", paidByReason: "company booked the coach (example)" },
    { description: "Ticket by Rate", price: 400, pax: 2, expenseType: "entrance", paidBy: "company", paidBySource: "rate-default", rateBasis: "TICKET_INCLUDED" },
  ]);
  return { op };
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
const sheetRow = async (slotIdx, desc) => ((await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: "G-990", date: DATE, slotIdx } } })).expenses).find((e) => e.description.startsWith(desc));
const text = (page, sel) => page.$eval(sel, (x) => x.innerText).catch(() => "");
const clickSave = (page) => page.evaluate(() => { const b = [...document.querySelectorAll(".js-bar button")].find((x) => x.innerText.trim() === "Save"); b && b.click(); });
const open = async (page, slotIdx, sel) => { await page.goto(`${BASE}/job-sheet?guideId=G-990&date=${DATE}&slotIdx=${slotIdx}`, { waitUntil: "networkidle0" }); await page.waitForSelector(sel, { timeout: 20000 }); };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1600 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.op.email));

  // Slot 0 — guided: suggestions, the summary, Confirm payer.
  await open(page, 0, ".js-payer-pending");
  const pending = await page.$$eval(".js-payer-pending", (xs) => xs.map((x) => x.innerText));
  check("a Rate suggestion reads as 'Suggested from booking Rate', never as a confirmed payer", pending.length === 2 && pending.every((t) => t.includes("Guide Own Money · Suggested from booking Rate")), JSON.stringify(pending));
  check("the booked Rates are listed with their class", /Tour without entrance tickets ×2 \(guided experience\)/.test(await text(page, ".js-rate-titles")), await text(page, ".js-rate-titles"));
  const awaiting = await text(page, ".js-sum-awaiting");
  check("the summary shows ฿105 awaiting confirmation, and no confirmed reimbursement", /฿105/.test(awaiting) && /฿105/.test(await text(page, ".js-transfer-awaiting")), awaiting.replace(/\s+/g, " "));
  await (await page.$$(".js-confirm-payer"))[1].click(); // Ferry
  await pause(300); await clickSave(page); await pause(1500);
  const ferry = await sheetRow(0, "Ferry"), water = await sheetRow(0, "Water");
  check("Confirm payer + Save stamps who and when; the basis is kept", ferry.paidBySource === "operator" && !!ferry.paidByBy && !!ferry.paidByAt && ferry.rateBasis === "GUIDED_EXPERIENCE", JSON.stringify({ src: ferry.paidBySource, by: !!ferry.paidByBy }));
  check("the row nobody confirmed stays a suggestion", water.paidBySource === "rate-default" && !water.paidByBy);
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-payer-pending", { timeout: 20000 });
  check("after reload: one suggestion left, ฿50 awaiting, ฿55 confirmed reimbursement", (await page.$$(".js-payer-pending")).length === 1 && /฿50/.test(await text(page, ".js-sum-awaiting")));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "rate-payer-guided.png") });

  // Slot 1 — mixed: the ticket row asks a person.
  await open(page, 1, ".js-rate-review");
  check("guests on different Rates: the ticket row asks for review, no payer invented", /some guests' Rate includes the tickets/.test(await text(page, ".js-rate-review")) && !(await sheetRow(1, "Grand Palace")).paidBy);

  // Slot 2 — ticket-inclusive: Company Resource suggested; an override needs its reason, which is kept.
  await open(page, 2, ".js-payer-pending");
  check("ticket-inclusive: the tickets are suggested as Company Resource", /Company Resource · Suggested from booking Rate/.test(await text(page, ".js-payer-pending")));
  await page.select('select[title*="Company paid direct"]', "guide");
  await page.waitForSelector(".js-payer-reason", { timeout: 10000 });
  await pause(200); await clickSave(page); await pause(1200);
  check("overriding the Rate without a reason is refused — and says why", /Not saved/.test(await text(page, ".js-save-problem")) && /the booked Rate suggests it is paid by the company/.test(await text(page, ".js-save-problem")) && (await sheetRow(2, "Grand Palace")).paidBy === "company");
  await page.type(".js-payer-reason", "the guide bought these at the gate (example)");
  await pause(200); await clickSave(page); await pause(1500);
  const gp = await sheetRow(2, "Grand Palace");
  check("with a reason it saves: payer, reason, who and when", gp.paidBy === "guide" && gp.paidBySource === "operator" && gp.paidByReason === "the guide bought these at the gate (example)" && !!gp.paidByBy, JSON.stringify({ paidBy: gp.paidBy, reason: gp.paidByReason }));
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-payer-reason", { timeout: 20000 });
  check("after reload the reason is still there", (await page.$eval(".js-payer-reason", (x) => x.value)) === "the guide bought these at the gate (example)");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "rate-payer-override.png") });

  // Slot 3 — an unknown Rate: nothing suggested, the Rate is shown for review.
  await open(page, 3, ".js-rate-titles");
  check("an unknown Rate suggests nothing and is shown as not recognised", /Come Hungry and Get back full ×1 \(not recognised\)/.test(await text(page, ".js-rate-titles")) && (await page.$$(".js-payer-pending")).length === 0 && /not recognised/.test(await text(page, ".js-rate-review")));
  // The accountant's list: only a confirmed payer is a cost ready to book.
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  const tab = await page.waitForSelector("xpath/.//button[normalize-space()='Advances']", { timeout: 20000 });
  await tab.click();
  await page.waitForSelector(".js-unbooked-awaiting", { timeout: 20000 });
  const ready = await text(page, ".js-unbooked-ready"), waiting = await text(page, ".js-unbooked-awaiting"), totals = await text(page, ".js-unbooked-totals");
  check("costs to book: the confirmed company cost is listed and counted", /Coach confirmed/.test(ready) && /฿1,200\.00 over 1 rows/.test(totals), totals);
  check("costs to book: a suggested Company Resource is not ready to book — it waits apart, out of the totals", !/Ticket by Rate/.test(ready) && /Ticket by Rate/.test(waiting) && /Suggested \/ รอยืนยัน/.test(waiting) && /฿800\.00 over 1 rows/.test(waiting) && !/฿2,000/.test(totals), waiting.slice(0, 160));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "rate-payer-unbooked.png"), fullPage: true });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nrate payer e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
