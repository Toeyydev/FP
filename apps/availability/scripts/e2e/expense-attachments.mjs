// Receipts on Tour Expense rows in a real browser, against a real server and database, with
// Google faked at the network layer (scripts/e2e/drive-fake.cjs): a guide attaches two files
// to a row of their own job at 390px and is told when the same file comes again; the office
// sees them, adds a PDF to another row and removes one with a reason; an accountant sees the
// files and no way to add. Run after `next build`:  node scripts/e2e/expense-attachments.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates). All data invented — this repo is public.

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
const PORT = Number(process.env.E2E_PORT ?? 3993);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(OUTBOUND, ""); writeFileSync(DRIVE_LOG, "");
const PASSWORD = "e2e-password-not-real-1";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";

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
function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
// Three small real files: two PNGs (different pixels) and a PDF.
const FILES = join(tmpdir(), "folkops-e2e-receipts"); mkdirSync(FILES, { recursive: true });
const PNG1 = join(FILES, "ticket-one.png"), PNG2 = join(FILES, "ticket-two.png"), PDF1 = join(FILES, "boat receipt.pdf");
writeFileSync(PNG1, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
writeFileSync(PNG2, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
writeFileSync(PDF1, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const DATE = "2099-11-06";
async function seed() {
  const tables = ["AuditLog", "ExpenseAttachment", "ReceiptClassification", "Notification", "GoogleCalendar", "ExpenseCertificate", "JobSheet", "Booking", "Assignment", "Checkin", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const admin = await prisma.user.create({ data: { email: "admin-r@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "acct-r@example.test", displayName: "Accountant Example", fullName: "Accountant Example", role: "ACCOUNTANT", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g994@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: "G-994", role: "GUIDE", state: "ACTIVE", passwordHash: hash, consentAt: new Date(), claimedAt: new Date() } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("e2e-refresh-token"), email: "admin-r@example.test" } });
  await prisma.assignment.create({ data: { guideId: "G-994", date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-RCPT-01", guideId: "G-994", date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: [
      { description: "Grand Palace", expenseType: "entrance", price: 500, pax: 2, paidBy: "guide", paidBySource: "operator" },
      { description: "Boat (example)", expenseType: "transport", price: 100, pax: 2, paidBy: "guide", paidBySource: "operator" },
    ] } });
}

// ── server ───────────────────────────────────────────────────────────────────
async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    // Attaching to PEAK switched on, so the admin's button is on the page — opening it must still send nothing.
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", FAKE_DRIVE_LOG: DRIVE_LOG, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET },
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
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sheetUrl = `${BASE}/job-sheet?guideId=G-994&date=${DATE}&slotIdx=0`;
const live = () => prisma.expenseAttachment.count({ where: { status: "UPLOADED" } });
const attach = async (page, input, path) => {
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes("/api/jobsheet/attachments") && r.request().method() === "POST", { timeout: 20000 }), (await page.$(input)).uploadFile(path)]);
  return res;
};
try {
  // The guide, on a phone.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie("g994@example.test"));
    await page.goto(sheetUrl, { waitUntil: "networkidle0" });
    await page.waitForSelector(".gs-receipts .js-receipt-add input", { timeout: 20000 });
    const first = ".gs-exp li:first-child .js-receipt-add input";
    await attach(page, first, PNG1);
    await page.waitForFunction(() => document.querySelectorAll(".gs-exp li:first-child .js-receipt-file").length === 1, { timeout: 15000 });
    await attach(page, ".gs-exp li:first-child .js-receipt-add input", PNG2);
    await page.waitForFunction(() => document.querySelectorAll(".gs-exp li:first-child .js-receipt-file").length === 2, { timeout: 15000 });
    check("guide 390px: two files on one row of their own job", (await live()) === 2);
    const res = await attach(page, ".gs-exp li:first-child .js-receipt-add input", PNG1);
    await page.waitForSelector(".gs-exp li:first-child .js-receipt-failed", { timeout: 10000 });
    const said = await page.$eval(".gs-exp li:first-child .js-receipts", (x) => x.textContent);
    check("guide 390px: the same file again is refused and said so, with Retry", res.status() === 409 && /already attached/.test(said) && /Retry/.test(said), said);
    const folders = await prisma.expenseAttachment.findFirst({ where: { status: "UPLOADED" } });
    check("filed in the job's own Receipts folder", !!folders?.driveFolderId && /FOLDER[^\n]*\nFOLDER/.test((await import("node:fs")).readFileSync(DRIVE_LOG, "utf8")));
    // No receipt + why, on the second row (owner, 2026-11-07): a ready-made reason, kept on the row.
    await page.click(".gs-exp li:nth-child(2) .js-no-receipt-add");
    await page.waitForSelector(".gs-exp li:nth-child(2) .js-no-receipt-pick", { timeout: 5000 });
    const saidWhy = page.waitForResponse((r) => r.url().includes("/api/jobsheet/no-receipt"), { timeout: 15000 });
    await page.select(".gs-exp li:nth-child(2) .js-no-receipt-pick", "ตั๋วหรือใบเสร็จหาย");
    await saidWhy;
    await page.waitForSelector(".gs-exp li:nth-child(2) .js-no-receipt", { timeout: 10000 });
    const whyShown = await page.$eval(".gs-exp li:nth-child(2) .js-no-receipt", (x) => x.textContent);
    const whyRow = ((await prisma.jobSheet.findFirstOrThrow()).expenses)[1];
    check("guide 390px: No receipt + a reason on a row of their own job, kept on the row", /No receipt · ตั๋วหรือใบเสร็จหาย/.test(whyShown) && whyRow.noReceipt?.reason === "ตั๋วหรือใบเสร็จหาย" && whyRow.noReceipt?.role === "GUIDE", `${whyShown} ${JSON.stringify(whyRow.noReceipt)}`);
    check("guide 390px: a row with files offers no 'No receipt'", (await page.$(".gs-exp li:first-child .js-no-receipt-add")) === null);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "receipts-no-receipt-390.png"), fullPage: true });
    check("guide 390px: no sideways scroll", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check("guide 390px: no page error", errors.length === 0, errors.join(" | ").slice(0, 200));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "receipts-guide-390.png"), fullPage: true });
    await page.close();
  }
  // The office, on a desktop.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "wrong photo (e2e)" : undefined));
    await page.setCookie(await sessionCookie("admin-r@example.test"));
    await page.goto(sheetUrl, { waitUntil: "networkidle0" });
    await page.waitForSelector("table .js-receipts", { timeout: 20000 });
    const shown = await page.$$eval("table .js-receipts", (cells) => cells.map((c) => c.querySelectorAll(".js-receipt-file").length));
    check("office: sees the guide's two files on that row", shown[0] === 2, JSON.stringify(shown));
    const cells = await page.$$("table .js-receipts");
    const input = await cells[1].$(".js-receipt-add input");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/jobsheet/attachments") && r.ok(), { timeout: 20000 }), input.uploadFile(PDF1)]);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("table .js-receipts", { timeout: 20000 });
    const after = await page.$$eval("table .js-receipts", (cells) => cells.map((c) => c.querySelectorAll(".js-receipt-file").length));
    check("office: a PDF on another row, still there after reload", after[0] === 2 && after[1] === 1, JSON.stringify(after));
    const [rm] = await page.$$("table .js-receipt-remove");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/jobsheet/attachments") && r.request().method() === "DELETE", { timeout: 20000 }), rm.click()]);
    const removed = await prisma.expenseAttachment.findFirst({ where: { status: "REMOVED" } });
    check("office: removing keeps who and why, and the Drive file", removed?.removeReason === "wrong photo (e2e)" && !!removed?.driveFileId && !/DELETE/.test((await import("node:fs")).readFileSync(DRIVE_LOG, "utf8")));
    const sheet = await prisma.jobSheet.findFirst();
    check("amounts unchanged by any of it", JSON.stringify(sheet.expenses.map((e) => [e.price, e.pax, e.paidBy])) === JSON.stringify([[500, 2, "guide"], [100, 2, "guide"]]));
    check("office: no page error", errors.length === 0, errors.join(" | ").slice(0, 200));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "receipts-office.png") });
    await page.close();
  }
  // The accountant: sees, cannot add.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie(await sessionCookie("acct-r@example.test"));
    await page.goto(sheetUrl, { waitUntil: "networkidle0" });
    await page.waitForSelector(".js-receipt-file", { timeout: 20000 });
    const can = await page.$$(".js-receipt-add");
    check("accountant: sees the files and no way to add", can.length === 0);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nexpense attachments e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
