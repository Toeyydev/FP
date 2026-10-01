// Advance settlement Phase 1D — the operational UI, in a real browser against a real server
// and database, with Google faked at the network layer (scripts/e2e/drive-fake.cjs) and every
// other outbound call recorded (outbound-guard.cjs). Drives, as an operator, an accountant and
// a guide: creating advances with categories (and the "other" reason), the Company Advance
// payer option and the chooser, settling, returns (verify / allocate / excess), the two-step
// refund with its slip, role limits, and the read-only view while writes are frozen.
// All data invented. Run after `next build`:  node scripts/e2e/advance-operations.mjs
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

// ── data ─────────────────────────────────────────────────────────────────────

// ── data (invented) ──────────────────────────────────────────────────────────
const DATE = "2099-10-10";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const SLIP = join(tmpdir(), "folkops-e2e-slip.png");
writeFileSync(SLIP, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const PEAK_CONFIG = JSON.stringify({ advanceAccountCode: "1199", bankAccountCode: "1111", bankAccountSubId: "bank-e2e", bankName: "Example Bank (e2e)", journalTypeIds: { ADVANCE: "J1", RETURN: "J2", EXPENSE: "J3" } });
function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
async function seed() {
  // The tables src/test/db.ts resets, plus the Drive connection — never the reference rows the
  // migrations seed (PeakAccountMapping), which later suites on the same database rely on.
  const tables = ["AuditLog", "Checkin", "TourReport", "PushSubscription", "Notification", "GoogleCalendar",
    "AdvancePeakDocumentLink", "AdvancePeakSync", "GuideAdvanceEntry", "GuideAdvanceRefund", "GuideAdvanceReceipt", "GuideAdvanceReturn", "GuideAdvance",
    "GuidePaymentSupplementLine", "SupplementalPayment", "Bonus", "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument",
    "ExpenseCertificate", "AttesterSignature", "HistoricalEvidenceReview",
    "PaymentTransaction", "PaymentEvidence", "PaymentBatchItem", "PaymentBatch", "TourPayment", "PayrollStatus", "JobSheet", "Booking", "Assignment",
    "Availability", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const admin = await prisma.user.create({ data: { email: "admin-ops@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "acct@example.test", displayName: "Accountant Example", fullName: "Accountant Example", role: "ACCOUNTANT", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g993@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: "G-993", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("e2e-refresh-token"), email: "admin-ops@example.test" } });
  for (const slotIdx of [0, 1]) await prisma.assignment.create({ data: { guideId: "G-993", date: DATE, slotIdx, tourId: "T-900", pax: 2 } });
  const j0 = await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-OPS-01", guideId: "G-993", date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: [
      { description: "Lunch (example)", expenseType: "meal", price: 150, pax: 2, paidBy: "" },
      { description: "Grand Palace", expenseType: "entrance", price: 500, pax: 1, paidBy: "" },
      { description: "Boat (example)", expenseType: "transport", price: 100, pax: 1, paidBy: "guide", paidBySource: "operator" },
    ] } });
  const j1 = await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-OPS-02", guideId: "G-993", date: DATE, slotIdx: 1, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
    // An older row: Company Advance, with nothing saying who chose it (no paidBySource).
    expenses: [{ description: "Old ticket (example)", expenseType: "entrance", price: 200, pax: 1, paidBy: "advance" }] } });
  // Another job's advance (for an excess) and another job's pending return (must not show on job 0).
  const c = await prisma.guideAdvance.create({ data: { guideId: "G-993", date: DATE, slotIdx: 1, amount: 1000, paidAt: new Date(), method: "bank", txRef: "TX-E2E-C", advanceNo: "FOLK-ADV-209910-901", advanceDate: "2026-09-30", amountSatang: 100000, accountingPeriod: "2026-09", jobNo: j1.ref, allowedCategories: ["entrance"] } });
  await prisma.guideAdvanceReceipt.create({ data: { receiptNo: "FOLK-ADR-209910-902", guideId: "G-993", receivedDate: "2026-09-30", amountSatang: 5000, status: "CLAIMED", method: "bank", jobSheetId: j1.id } });
  return { admin, j0, j1, c };
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
const data = await seed();
let server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const text = (page, sel) => page.$eval(sel, (x) => x.innerText).catch(() => "");
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const clickSave = (page) => page.evaluate(() => { const b = [...document.querySelectorAll(".js-bar button")].find((x) => x.innerText.trim() === "Save"); b && b.click(); });
const clickText = (page, scope, label) => page.evaluate((scope, label) => { const root = scope ? document.querySelector(scope) : document; const b = [...(root?.querySelectorAll("button") ?? [])].find((x) => x.innerText.trim().startsWith(label) && !x.disabled); if (b) b.click(); return !!b; }, scope, label);
const J0 = `${BASE}/job-sheet?guideId=G-993&date=${DATE}&slotIdx=0`;
const rows = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.j0.id } })).expenses;
const adv = (no) => prisma.guideAdvance.findUniqueOrThrow({ where: { advanceNo: no } });
const payerOptions = (page, i) => page.evaluate((i) => [...document.querySelectorAll(".js-payer-select")][i] ? [...[...document.querySelectorAll(".js-payer-select")][i].options].map((o) => o.value) : [], i);
const setPayer = (page, i, v) => page.evaluate((i, v) => { const s = [...document.querySelectorAll(".js-payer-select")][i]; s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); }, i, v);
async function openCreate(page) {
  if (!(await page.$(".js-advance-create-categories"))) await clickText(page, ".advance-settlement", "+ Record advance");
  await page.waitForSelector(".js-advance-create-categories");
}
async function fillAmountRef(page, amount, txRef) {
  await page.evaluate((amount, txRef) => {
    const f = document.querySelector(".js-advance-create-categories").parentElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const field = (start) => [...f.querySelectorAll("label")].find((l) => l.innerText.startsWith(start)).querySelector("input");
    for (const [el, v] of [[field("Amount"), String(amount)], [field("Transfer ref"), txRef]]) { set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }
  }, amount, txRef);
}
async function createAdvanceInEditor(page, { amount, txRef, cats, otherReason }) {
  await openCreate(page);
  const form = await page.$(".js-advance-create-categories");
  const box = await form.evaluateHandle((f) => f.parentElement);
  await fillAmountRef(page, amount, txRef);
  await page.waitForFunction(() => [...document.querySelectorAll(".js-advance-create-categories")].length && [...document.querySelector(".js-advance-create-categories").parentElement.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.value === "bank-e2e")), { timeout: 10000 });
  await page.evaluate(() => { const s = [...document.querySelector(".js-advance-create-categories").parentElement.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "bank-e2e")); s.value = "bank-e2e"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  for (const k of ["entrance", "meal", "transport", "other"]) {
    const want = cats.includes(k);
    await page.evaluate((k, want) => { const c = document.querySelector(`.js-create-cat[value="${k}"]`); if (c.checked !== want) c.click(); }, k, want);
  }
  if (otherReason) { await page.waitForSelector(".js-create-other-reason"); await page.type(".js-create-other-reason", otherReason); }
  const file = await box.$('input[type="file"]');
  await file.uploadFile(SLIP);
  await pause(200);
  await page.click(".js-advance-submit");
  await pause(2500);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1800 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setCookie(await sessionCookie("admin-ops@example.test"));
  await page.goto(J0, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-payer-select", { timeout: 20000 });

  // 7 — no advance on the job: Company Advance is not offered.
  check("7 · Company Advance is not offered while no advance on the job may pay for it", !(await payerOptions(page, 0)).includes("advance"));

  // 2 — create an advance for entrance + meal through the job sheet.
  await createAdvanceInEditor(page, { amount: 1000, txRef: "TX-E2E-A", cats: ["entrance", "meal"] });
  const all1 = await prisma.guideAdvance.findMany({ where: { date: DATE, slotIdx: 0 }, orderBy: { createdAt: "asc" } });
  const A = all1[0];
  check("2 · an advance created on the job sheet with meals allowed (slip stored through the upload)", !!A && JSON.stringify(A.allowedCategories) === JSON.stringify(["entrance", "meal"]) && /fake-upload/.test(A.slipUrl ?? ""), JSON.stringify(A?.allowedCategories));

  // 4 — "other" without a reason is refused by the form; with one it is created and the reason is in the history.
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-payer-select");
  await openCreate(page);
  await fillAmountRef(page, 500, "TX-E2E-NOREASON");
  for (const k of ["transport", "other"]) await page.evaluate((k) => document.querySelector(`.js-create-cat[value="${k}"]`).click(), k);
  await page.click(".js-advance-submit");
  await pause(700);
  check("4 · enabling 'other' without a reason is refused before anything is sent", /Say why this advance may pay for other costs/.test(await bodyText(page)) && (await prisma.guideAdvance.count({ where: { date: DATE, slotIdx: 0 } })) === 1);
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-payer-select");
  await createAdvanceInEditor(page, { amount: 500, txRef: "TX-E2E-B", cats: ["entrance", "transport", "other"], otherReason: "longtail boat hire on the river (example)" });
  const B = (await prisma.guideAdvance.findMany({ where: { date: DATE, slotIdx: 0 }, orderBy: { createdAt: "asc" } }))[1];
  const bHist = await prisma.auditLog.findFirst({ where: { action: "advance.categories_changed", entityId: B?.id } });
  check("3, 5 · an advance with transport and 'other' — the reason, who and when are in its history", !!B && bHist?.detail?.otherReason === "longtail boat hire on the river (example)" && bHist?.actorId === data.admin.id && !!bHist?.detail?.at, JSON.stringify(bHist?.detail));

  // 8 — one eligible advance (meals: only A): offered, no chooser.
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".js-payer-select");
  check("8 · Company Advance is offered for the meal row (one advance allows meals)", (await payerOptions(page, 0)).includes("advance"));
  await setPayer(page, 0, "advance");
  await pause(300);
  check("8 · …and choosing it opens no chooser", (await page.$(".js-advance-chooser")) === null);

  // 9 — two eligible advances for the ticket row (A and B both allow entrance): the chooser lists both.
  await setPayer(page, 1, "advance");
  await page.waitForSelector(".js-advance-chooser", { timeout: 5000 });
  const chooserText = await text(page, ".js-advance-chooser");
  check("9 · two advances fit → the chooser shows both, with amount, outstanding, status and categories", chooserText.includes(A.advanceNo) && chooserText.includes(B.advanceNo) && /entrance, meal/.test(chooserText) && /entrance, transport, other/.test(chooserText), chooserText.slice(0, 200));
  await page.click(`.js-advance-choose[data-advance="${B.advanceNo}"]`);
  await pause(300);

  // 10 — the chosen advance is reversed before the save: the server refuses, nothing linked.
  await prisma.guideAdvance.update({ where: { id: B.id }, data: { reversedAt: new Date(), reversalReason: "e2e stale check" } });
  await clickSave(page); await pause(1800);
  const stale = await bodyText(page);
  check("10 · a choice that is no longer valid at save time is refused by the server, and said why", /Not saved/.test(stale) && /cannot pay for this row|can't be confirmed/.test(stale), stale.match(/Not saved[\s\S]{0,200}/)?.[0]);
  await prisma.guideAdvance.update({ where: { id: B.id }, data: { reversedAt: null, reversalReason: null } });
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-payer-select");
  await setPayer(page, 0, "advance"); await pause(200);
  await setPayer(page, 1, "advance"); await page.waitForSelector(".js-advance-chooser");
  await page.click(`.js-advance-choose[data-advance="${B.advanceNo}"]`); await pause(200);
  await clickSave(page); await pause(2000);
  const r1 = await rows();
  check("9 · saved: the meal row is linked to A, the ticket row to the chosen B", r1[0].advanceId === A.id && r1[1].advanceId === B.id, JSON.stringify(r1.map((r) => r.advanceId)));

  // Approve the sheet (the approval itself is covered elsewhere) and reopen.
  await prisma.jobSheet.update({ where: { id: data.j0.id }, data: { approvalStatus: "APPROVED", approvedAt: new Date(), approvedBy: data.admin.id } });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".js-adv-card");

  // 11 — settle B with the ticket row through the panel.
  await page.click(`.js-adv-card[data-advance="${B.advanceNo}"] .js-adv-pick`);
  await page.click(`.js-adv-card[data-advance="${B.advanceNo}"] .js-adv-settle`);
  await pause(2200);
  const eB = await prisma.guideAdvanceEntry.findMany({ where: { advanceId: B.id, type: "EXPENSE_SETTLEMENT" } });
  check("11 · settled from the panel: one entry of ฿500 for B, the amount worked out by the server", eB.length === 1 && eB[0].amountSatang === 50000);
  check("11 · the card reads the ledger: B used ฿500, outstanding ฿0, Settled", /Used ฿500\.00/.test(await text(page, `.js-adv-card[data-advance="${B.advanceNo}"] .js-adv-figures`)) && /Settled/.test(await text(page, `.js-adv-card[data-advance="${B.advanceNo}"]`)));

  // 12 — a double press settles once.
  await page.click(`.js-adv-card[data-advance="${A.advanceNo}"] .js-adv-pick`);
  await page.evaluate((no) => { const b = document.querySelector(`.js-adv-card[data-advance="${no}"] .js-adv-settle`); b.click(); b.click(); }, A.advanceNo);
  await pause(2500);
  check("12 · pressing Settle twice settles once", (await prisma.guideAdvanceEntry.count({ where: { advanceId: A.id, type: "EXPENSE_SETTLEMENT" } })) === 1);

  // 13 — a counter that disagrees with the ledger is shown, and settling is off.
  const aRow = await adv(A.advanceNo);
  await prisma.$executeRawUnsafe(`UPDATE "GuideAdvance" SET "settledSatang" = ${aRow.settledSatang + 1000} WHERE id = '${A.id}'`);
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-adv-card");
  check("13 · a ledger that does not add up is flagged on the advance", /does not add up/.test(await text(page, `.js-adv-card[data-advance="${A.advanceNo}"] .js-adv-problem`)));
  await prisma.$executeRawUnsafe(`UPDATE "GuideAdvance" SET "settledSatang" = ${aRow.settledSatang} WHERE id = '${A.id}'`);

  // 6 — the category edit: adding transport is saved and audited; removing meals (the settled lunch row uses it) is refused.
  const card = `.js-adv-card[data-advance="${A.advanceNo}"]`;
  await page.click(`${card} .js-adv-edit-categories`);
  await page.click(`${card} .js-adv-category-form input[value="transport"]`);
  await page.click(`${card} .js-adv-save-categories`);
  await pause(1500);
  check("6 · adding a category from the panel is saved, with a history entry", JSON.stringify((await adv(A.advanceNo)).allowedCategories) === JSON.stringify(["entrance", "meal", "transport"]) && (await prisma.auditLog.count({ where: { action: "advance.categories_changed", entityId: A.id } })) === 2);
  await page.click(`${card} .js-adv-edit-categories`);
  await page.click(`${card} .js-adv-category-form input[value="meal"]`);
  await page.click(`${card} .js-adv-save-categories`);
  await pause(1500);
  const t6 = await bodyText(page);
  check("6 · removing a category a settled row uses is refused, naming the row", /"Lunch \(example\)" \(meal\)/.test(t6) && JSON.stringify((await adv(A.advanceNo)).allowedCategories) === JSON.stringify(["entrance", "meal", "transport"]));

  // 14 — returns on this job only.
  const R1 = await prisma.guideAdvanceReceipt.create({ data: { receiptNo: "FOLK-ADR-209910-903", guideId: "G-993", receivedDate: "2026-09-30", amountSatang: 100000, status: "CLAIMED", method: "bank", jobSheetId: data.j0.id, advanceId: A.id } });
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".js-return-card");
  const cards = await page.$$eval(".js-return-card", (xs) => xs.map((x) => x.getAttribute("data-receipt")));
  check("14 · the job shows its own return, not the guide's pending return for another job", cards.includes(R1.receiptNo) && !cards.includes("FOLK-ADR-209910-902"), JSON.stringify(cards));

  // 15 — verify.
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-verify`);
  await page.type(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-bankref`, "BANK-E2E-LINE-1");
  await clickText(page, `.js-return-card[data-receipt="${R1.receiptNo}"]`, "Confirm it arrived");
  await pause(1800);
  check("15 · verified from the card", (await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: R1.id } })).status === "VERIFIED");

  // 16 — allocate to A, capped at A's outstanding (฿700).
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-allocate`);
  await page.waitForSelector(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-alloc-target`);
  await pause(600);
  await page.select(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-alloc-target`, A.id);
  await pause(200);
  const caps = await text(page, `.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-alloc-caps`);
  const pre = await page.$eval(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-alloc-amount`, (x) => x.value);
  check("16 · the allocation shows both caps and suggests no more than the smaller (฿700)", /at most ฿700\.00/.test(caps) && pre === "700", `${caps} / ${pre}`);
  await clickText(page, `.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-form`, "Allocate");
  await pause(2000);
  const aAfter = await adv(A.advanceNo);
  check("16 · allocated: A is settled", aAfter.settledSatang === aAfter.amountSatang);

  // 17 — the ฿300 beyond what this job owed is shown as an excess.
  await page.waitForSelector(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-excess-return`, { timeout: 5000 }).catch(() => {});
  check("17 · the excess is shown: เงินคืนเกินที่ต้องคืน ฿300", /Excess return[\s\S]*฿300\.00/.test(await text(page, `.js-return-card[data-receipt="${R1.receiptNo}"] .js-excess-return`)));

  // 18 — allocate ฿100 of the excess to another advance of the same guide, explicitly.
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-allocate`);
  await pause(800);
  await page.select(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-alloc-target`, data.c.id);
  await page.evaluate((no) => { const i = document.querySelector(`.js-return-card[data-receipt="${no}"] .js-return-alloc-amount`); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "100"); i.dispatchEvent(new Event("input", { bubbles: true })); }, R1.receiptNo);
  await clickText(page, `.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-form`, "Allocate");
  await pause(2000);
  check("18 · ฿100 of the excess allocated to the other job's advance — only because the operator chose it", (await adv("FOLK-ADV-209910-901")).settledSatang === 10000);

  // Phase 1E — each movement's PEAK state, and the amount a document for it must carry (operators only).
  const peakA = await text(page, `.js-adv-card[data-advance="${A.advanceNo}"] .js-adv-peak`);
  const peakR = await text(page, `.js-return-card[data-receipt="${R1.receiptNo}"] .js-return-peak`);
  check("1E · the advance card shows the issue and the settlement with their PEAK state", /issue ฿1,000\.00: not in PEAK yet/.test(peakA) && /settlement on this job ฿300\.00: not in PEAK yet/.test(peakA), peakA);
  check("1E · the return card shows the amount to link — what reached the advances", /return ฿800\.00 allocated to advances: not in PEAK yet/.test(peakR), peakR);

  // 19, 21 — record a refund of ฿100; the recorder sees they cannot approve it.
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-record`);
  await page.type(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-amount`, "100");
  await page.type(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-reason`, "guide sent too much (example)");
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-record-submit`);
  await pause(2000);
  const f1 = await prisma.guideAdvanceRefund.findFirst({ where: { receiptId: R1.id } });
  await page.waitForSelector(`.js-refund-row[data-refund="${f1?.refundNo}"]`, { timeout: 5000 }).catch(() => {});
  check("19 · refund recorded (RECORDED, nothing paid)", f1?.status === "RECORDED" && !f1?.paidAt);
  check("21 · the person who recorded it is told another person must approve — no Approve button for them", /another person must approve/.test(await text(page, `.js-refund-row[data-refund="${f1?.refundNo}"]`)) && (await page.$(`.js-refund-row[data-refund="${f1?.refundNo}"] .js-refund-approve`)) === null);

  // 20, 27 — the accountant (least privilege, owner policy 2026-10-01): on the job sheet, the
  // guide-style summary and no advance operations at all; on Payments → Advances, a review card
  // per refund carrying the evidence, and Approve — nothing else.
  const acctCtx = await browser.createBrowserContext();
  const ap = await acctCtx.newPage();
  ap.on("dialog", (d) => d.accept());
  ap.on("pageerror", (e) => errors.push(`accountant: ${e}`));
  await ap.setViewport({ width: 1280, height: 1800 });
  await ap.setCookie(await sessionCookie("acct@example.test"));
  await ap.goto(J0, { waitUntil: "networkidle0" });
  await pause(1500);
  const onSheet = await ap.evaluate(() => [".js-advance-ops", ".js-adv-card", ".js-adv-settle", ".js-adv-edit-categories", ".js-return-verify", ".js-return-allocate", ".js-return-link", ".js-return-void", ".js-refund-approve", ".js-refund-record", ".js-refund-pay", ".js-refund-void", ".js-payer-select", ".js-advance-submit"].filter((x) => document.querySelector(x)));
  const sheetButtons = await ap.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /^(Save|Approve|Send to guide|\+ Record advance)$/.test(t)));
  check("27 · on the job sheet the accountant gets no advance operations, no payer or expense editing, and no Save/Approve", onSheet.length === 0 && sheetButtons.length === 0, JSON.stringify({ onSheet, sheetButtons }));
  await ap.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await (await ap.waitForSelector("xpath/.//button[normalize-space()='Advances']")).click();
  const RCARD = `.js-refund-review-card[data-refund="${f1.refundNo}"]`;
  await ap.waitForSelector(RCARD, { timeout: 15000 });
  const ev = await ap.$eval(RCARD, (x) => x.innerText);
  const evidence = {
    refund: ev.includes(f1.refundNo) && /฿100\.00/.test(ev) && /Waiting for approval/i.test(ev) && /guide sent too much \(example\)/.test(ev),
    guide: /G-993 · Guide Example/.test(ev),
    job: /FOLK-TEST-OPS-01 · 2099-10-10/.test(ev),
    ret: /FOLK-ADR-209910-903/.test(ev) && /Amount ฿1,000\.00 · Allocated ฿800\.00 · Refunded ฿0\.00 · Unallocated ฿200\.00/.test(ev) && /BANK-E2E-LINE-1/.test(ev),
    advances: ev.includes(A.advanceNo) && ev.includes("FOLK-ADV-209910-901") && /Issued ฿1,000\.00 · Used ฿300\.00 · Returned ฿700\.00/.test(ev),
    history: /Recorded by Admin Example \(admin\)/.test(ev),
  };
  check("20 · the accountant opens the refund review and sees the evidence: refund, guide, job, return, advances, bank reference, history", Object.values(evidence).every(Boolean), JSON.stringify(evidence));
  check("20 · the advance slip is linked as evidence", /📎 Advance slip/.test(ev));
  const reviewControls = await ap.evaluate(() => [...document.querySelectorAll(".js-refund-review button")].map((b) => b.innerText.trim()));
  const pageControls = await ap.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /^(Record advance…|Confirm|Allocate…|Reverse|Void|Mark paid|Record refund|Settle)/.test(t)));
  check("27 · the review offers Approve and nothing else; the Advances page offers the accountant no other advance action", JSON.stringify(reviewControls) === JSON.stringify(["Approve refund"]) && pageControls.length === 0, JSON.stringify({ reviewControls, pageControls }));
  await ap.click(`${RCARD} .js-review-approve`);
  await pause(1800);
  const f1b = await prisma.guideAdvanceRefund.findUniqueOrThrow({ where: { id: f1.id } });
  check("20 · approved by the accountant", f1b.status === "APPROVED" && !!f1b.approvedById && f1b.approvedById !== data.admin.id);
  check("20 · the card now shows the approval in its history", /Approved by Accountant Example \(accountant\)/.test(await ap.$eval(RCARD, (x) => x.innerText)));
  const acctTry = await ap.evaluate(async (ids) => {
    const j = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.status);
    return [
      await j(`/api/advances/refunds/${ids.f}/pay`, { bankRef: "ACC-TRY", paidAt: "2099-10-01T10:00:00+07:00" }),
      await j(`/api/advances/refunds/${ids.f}/void`, { reason: "accountant try (example)" }),
      await j(`/api/advances/returns/${ids.r}/refunds`, { amount: 10, reason: "accountant try (example)" }),
      await j(`/api/advances/returns/${ids.r}/allocate`, { allocations: [{ advanceId: ids.a, amount: 1 }], requestKey: "acc-try-example" }),
      await j(`/api/advances/returns/${ids.r}/void`, { reason: "accountant try (example)" }),
      await j(`/api/advances/${ids.a}/settle-expenses`, { jobSheetId: ids.j, sheetVersion: "x", lines: [] }),
      await j(`/api/advances/${ids.a}/categories`, { allowedCategories: ["entrance"] }),
    ];
  }, { f: f1.id, r: R1.id, a: A.id, j: data.j0.id });
  check("27 · the server refuses the accountant every other advance write (403)", acctTry.every((x) => x === 403), JSON.stringify(acctTry));
  await acctCtx.close();

  // 22, 23 — the operator records the payment with the slip.
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(`.js-refund-row[data-refund="${f1.refundNo}"] .js-refund-pay`);
  await page.click(`.js-refund-row[data-refund="${f1.refundNo}"] .js-refund-pay`);
  await page.type(`.js-refund-row[data-refund="${f1.refundNo}"] .js-refund-bankref`, "REFUND-E2E-1");
  await (await page.$(`.js-refund-row[data-refund="${f1.refundNo}"] .js-refund-file`)).uploadFile(SLIP);
  await pause(200);
  await page.click(`.js-refund-row[data-refund="${f1.refundNo}"] .js-refund-pay-submit`);
  await pause(2500);
  const f1c = await prisma.guideAdvanceRefund.findUniqueOrThrow({ where: { id: f1.id } });
  check("22 · refund paid: date, bank reference and who paid recorded", f1c.status === "PAID" && f1c.bankRef === "REFUND-E2E-1" && f1c.paidById === data.admin.id && !!f1c.paidAt);
  check("23 · the transfer slip was stored through the shared upload", /fake-upload/.test(f1c.slipUrl ?? "") && /UPLOAD/.test(readFileSync(DRIVE_LOG, "utf8")));

  // 24 — record a second refund and void it; 25 — the paid one cannot be voided.
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-record`);
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-record`);
  await page.type(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-amount`, "50");
  await page.type(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-reason`, "second part back (example)");
  await page.click(`.js-return-card[data-receipt="${R1.receiptNo}"] .js-refund-record-submit`);
  await pause(1800);
  const f2 = await prisma.guideAdvanceRefund.findFirst({ where: { receiptId: R1.id, status: "RECORDED" } });
  await page.click(`.js-refund-row[data-refund="${f2.refundNo}"] .js-refund-void`);
  await page.type(`.js-refund-row[data-refund="${f2.refundNo}"] input`, "guide will collect it in cash (example)");
  await page.click(`.js-refund-row[data-refund="${f2.refundNo}"] .js-refund-void-submit`);
  await pause(1800);
  check("24 · a recorded refund voided with a reason", (await prisma.guideAdvanceRefund.findUniqueOrThrow({ where: { id: f2.id } })).status === "VOIDED");
  const paidVoid = await page.evaluate(async (id) => { const r = await fetch(`/api/advances/refunds/${id}/void`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "try to undo (example)" }) }); return { s: r.status, b: await r.json() }; }, f1.id);
  check("25 · a paid refund offers no Void, and the server refuses it (409)", (await page.$(`.js-refund-row[data-refund="${f1.refundNo}"] .js-refund-void`)) === null && paidVoid.s === 409, JSON.stringify(paidVoid).slice(0, 160));

  // 26 — the guide: no operator controls, and the server refuses them.
  const gCtx = await browser.createBrowserContext();
  const gp = await gCtx.newPage();
  await gp.setCookie(await sessionCookie("g993@example.test"));
  await gp.goto(J0, { waitUntil: "networkidle0" });
  await pause(1500);
  const guideSees = await gp.evaluate(() => [".js-adv-settle", ".js-return-verify", ".js-return-allocate", ".js-refund-approve", ".js-refund-pay", ".js-refund-record", ".js-adv-edit-categories", ".js-return-void", ".js-adv-peak", ".js-return-peak", ".js-peak-unlink"].filter((s) => document.querySelector(s)));
  const guideTry = await gp.evaluate(async (id) => (await fetch(`/api/advances/returns/${id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bankRef: "BANK-GUIDE-TRY" }) })).status, R1.id);
  check("26 · the guide sees no operator accounting control, and the server answers 403", guideSees.length === 0 && guideTry === 403, JSON.stringify(guideSees));
  await gCtx.close();

  // 29 (the August shape) — an older Company Advance row that never recorded who chose it can be
  // confirmed from the sheet; the save then links it to the job's one advance that fits.
  await page.goto(`${BASE}/job-sheet?guideId=G-993&date=${DATE}&slotIdx=1`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-payer-select");
  const legacy = await page.evaluate(() => { const s = [...document.querySelectorAll(".js-payer-select")].find((x) => x.value === "advance"); const tr = s?.closest("tr"); return { pending: tr?.querySelector(".js-payer-pending")?.innerText ?? "", button: !!tr?.querySelector(".js-confirm-payer") }; });
  check("29 · an older Company Advance row with no recorded chooser reads 'awaiting confirmation' and offers Confirm payer", /Company Advance Money · awaiting confirmation/.test(legacy.pending) && legacy.button, JSON.stringify(legacy));
  await page.evaluate(() => [...document.querySelectorAll(".js-payer-select")].find((x) => x.value === "advance").closest("tr").querySelector(".js-confirm-payer").click());
  await pause(200);
  await clickSave(page); await pause(2200);
  const j1row = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.j1.id } })).expenses[0];
  check("29 · confirmed and saved: payer chosen by the operator, linked to the job's advance", j1row.paidBySource === "operator" && j1row.advanceId === data.c.id, JSON.stringify({ src: j1row.paidBySource, linked: j1row.advanceId === data.c.id }));

  // 30 — nothing else happened: no guide payment, no supplemental payment, no certificate, nothing to PEAK.
  const sideEffects = { gp: await prisma.guidePayment.count(), sp: await prisma.supplementalPayment.count(), certs: await prisma.expenseCertificate.count(), peak: await prisma.advancePeakSync.count({ where: { status: { in: ["SENDING", "UNCERTAIN", "POSTED"] } } }) };
  const outbound = readFileSync(OUTBOUND, "utf8");
  check("30 · no guide payment, supplemental payment or certificate; nothing sent to PEAK", sideEffects.gp === 0 && sideEffects.sp === 0 && sideEffects.certs === 0 && sideEffects.peak === 0 && !/peakaccount|peak\.co/i.test(outbound), JSON.stringify(sideEffects));
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "advance-operations.png"), fullPage: true });
  await page.close();

  // 1 — the Advances page: create with nothing changed → tickets only.
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1280, height: 1600 });
  await p2.setCookie(await sessionCookie("admin-ops@example.test"));
  await p2.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  await (await p2.waitForSelector("xpath/.//button[normalize-space()='Advances']")).click();
  await p2.waitForSelector("xpath/.//button[normalize-space()='Record advance…']", { timeout: 15000 });
  await p2.waitForSelector(".js-refunds-section", { timeout: 10000 }).catch(() => {});
  const listed = await p2.$$eval(".js-refunds-section .js-refund-row", (xs) => xs.map((x) => x.getAttribute("data-status")).sort().join(","));
  check("the Advances page lists the refunds with their state — paid and voided", listed === "PAID,VOIDED", listed);
  // Phase 1E — linking a settlement: chosen from the ledger with its exact amount, never typed.
  await p2.evaluate((no) => { const tr = [...document.querySelectorAll("tr")].find((x) => x.innerText.includes(no)); [...tr.querySelectorAll("button")].find((b) => b.innerText.trim() === "PEAK doc…").click(); }, A.advanceNo);
  await p2.waitForSelector(".sheet select");
  await p2.evaluate(() => { const s = [...document.querySelectorAll(".sheet select")].find((x) => [...x.options].some((o) => o.value === "EXPENSE")); s.value = "EXPENSE"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await p2.waitForSelector(".js-link-settlement select", { timeout: 10000 });
  const settlementPick = await text(p2, ".js-link-settlement");
  check("1E · the link dialog offers the recorded settlement and says the document must carry exactly its amount", /FOLK-TEST-OPS-01 · 2099-10-10 · ฿300\.00/.test(settlementPick) && /must carry exactly ฿300\.00/.test(settlementPick), settlementPick.slice(0, 200));
  await p2.evaluate(() => {
    const set = (el, v) => { const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set([...document.querySelectorAll(".sheet input")].find((i) => i.placeholder === "as PEAK shows it"), "JV-E2E-0001");
    set(document.querySelector(".sheet textarea"), "checked in PEAK by the accountant (example)");
  });
  await (await p2.waitForSelector("xpath/.//button[normalize-space()='Check in PEAK…']")).click();
  await p2.waitForSelector(".sheet .banner.danger", { timeout: 10000 });
  check("1E · with no PEAK connection the check is refused in plain words, and nothing is linked", /PEAK could not be asked about JV-E2E-0001/.test(await text(p2, ".sheet .banner.danger")) && (await prisma.advancePeakDocumentLink.count()) === 0);
  await (await p2.$("xpath/.//div[contains(@class,'sheet')]//button[normalize-space()='Cancel']")).click();
  await (await p2.$("xpath/.//button[normalize-space()='Record advance…']")).click();
  await p2.waitForSelector(".js-issue-categories");
  const typeIn = async (label, value) => p2.evaluate((label, value) => { const l = [...document.querySelectorAll(".modal label")].find((x) => x.innerText.trim().startsWith(label)); const i = l.querySelector("input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, value); i.dispatchEvent(new Event("input", { bubbles: true })); }, label, value);
  await typeIn("Guide ID", "G-993"); await typeIn("Amount", "300"); await typeIn("Job No.", data.j1.ref); await typeIn("Bank reference", "TX-E2E-D");
  await p2.waitForFunction(() => [...document.querySelectorAll(".modal select")].some((s) => [...s.options].some((o) => o.value === "bank-e2e")), { timeout: 10000 });
  await p2.evaluate(() => { const s = [...document.querySelectorAll(".modal select")].find((x) => [...x.options].some((o) => o.value === "bank-e2e")); s.value = "bank-e2e"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await (await p2.$('.modal input[type="file"]')).uploadFile(SLIP);
  await pause(200);
  await (await p2.$("xpath/.//div[contains(@class,'mfoot')]//button[normalize-space()='Record']")).click();
  await pause(2500);
  const D = await prisma.guideAdvance.findFirst({ where: { txRef: "TX-E2E-D" } });
  check("1 · an advance created on the Advances page with nothing changed may pay for tickets only", JSON.stringify(D?.allowedCategories) === JSON.stringify(["entrance"]), JSON.stringify(D?.allowedCategories));
  await p2.close();
} finally {
  await browser.close();
  server.kill();
}

// 28 — while ADVANCE_WRITES_FROZEN=1: a banner, no write controls, and the server answers 503.
await pause(1500);
server = await startServer({ ADVANCE_WRITES_FROZEN: "1" });
const b2 = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const fp = await b2.newPage();
  await fp.setViewport({ width: 1280, height: 1800 });
  await fp.setCookie(await sessionCookie("admin-ops@example.test"));
  await fp.goto(J0, { waitUntil: "networkidle0" });
  await fp.waitForSelector(".js-advance-frozen", { timeout: 20000 });
  const writable = await fp.evaluate(() => [".js-adv-settle", ".js-return-verify", ".js-return-allocate", ".js-refund-record", ".js-refund-pay", ".js-adv-edit-categories"].filter((s) => document.querySelector(s)));
  const frozenTry = await fp.evaluate(async () => (await fetch("/api/advances/returns/none/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bankRef: "X" }) })).status);
  check("28 · frozen: the banner shows, no write control is offered, and the server answers 503", writable.length === 0 && frozenTry === 503, JSON.stringify(writable));
  if (SHOTS) await fp.screenshot({ path: join(SHOTS, "advance-operations-frozen.png"), fullPage: true });
} finally {
  await b2.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nadvance operations e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
