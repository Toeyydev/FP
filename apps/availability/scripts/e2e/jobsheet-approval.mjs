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
const PORT = Number(process.env.E2E_PORT ?? 3989);
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
const CERT_NO = "CERT-FOLK-BKK-20990101-01-01";
const DRIVE = "https://drive.google.com/file/d/fileCertificateE2E00001/view";
async function seed() {
  const tables = ["AuditLog", "Notification", "PeakAttachment", "ExpenseCertificate", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const users = {};
  for (const [role, email, name] of [["ADMIN", "admin@example.test", "Malee Testsuite"], ["OPERATOR", "op@example.test", "Op Example"]]) {
    users[role] = await prisma.user.create({ data: { email, displayName: name, fullName: name, role, state: "ACTIVE", passwordHash: hash } });
  }
  await prisma.user.create({ data: { email: "g901@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: "G-901", role: "GUIDE", state: "ACTIVE" } });
  const e = (description, price, pax, over = {}) => ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });
  const mk = async (date, expenses) => {
    await prisma.assignment.create({ data: { guideId: "G-901", date, slotIdx: 0, tourId: "T-900", pax: 2 } });
    return prisma.jobSheet.create({ data: { ref: `FOLK-BKK-${date.replace(/-/g, "")}-01`, guideId: "G-901", date, slotIdx: 0, tourId: "T-900", status: "Confirmed", expenses, bookings: [],
      approvalStatus: "APPROVED", approvedBy: users.OPERATOR.id, approvedAt: new Date("2099-01-01T07:05:00Z"), certifiedAt: new Date("2099-01-01T06:00:00Z") } });
  };
  const withCert = await mk("2099-01-01", [e("Ferry", 15, 2)]);
  const identity = ["Ferry", 1500, 200, "transport", "guide"].join("|");
  const cert = await prisma.expenseCertificate.create({ data: { certificateNo: CERT_NO, jobSheetId: withCert.id, activeJobSheetId: withCert.id, guideId: "G-901", jobRef: withCert.ref, tourDate: withCert.date, slotIdx: 0,
    status: "LINKED", payload: {}, payloadHash: "a".repeat(64), coveredRows: [{ index: 0, identity, description: "Ferry", pax: 2, price: 15, amountSatang: 3000, category: "transport" }], totalSatang: 3000,
    source: "ADMIN_RECORDED", sourceSheetUpdatedAt: withCert.updatedAt, pdfHash: "b".repeat(64), driveFileId: "fileCertificateE2E00001", driveUrl: DRIVE, linkedAt: new Date("2099-01-02T00:00:00Z") } });
  await prisma.jobSheet.update({ where: { id: withCert.id }, data: { expenses: [{ ...e("Ferry", 15, 2), evidenceWaiver: { by: users.ADMIN.id, at: "2099-01-02T00:00:00Z", reason: "ใบรับรองแทนใบเสร็จ (ตัวอย่าง)", certificateId: cert.id, certificateNo: CERT_NO } }] } });
  const needs = await mk("2099-01-02", [e("Bus", 15, 3)]);
  return { users, withCert, needs };
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
const LEGACY = [/ข้าพเจ้าขอรับรอง/, /CERTIFIED BY/i, /ผู้จัดทำ \/ ผู้รับรอง/, /date set on first save/];
const APPROVAL = '[aria-label="การอนุมัติค่าใช้จ่าย"]';
const REF = '[aria-label="ใบรับรองแทนใบเสร็จรับเงินของใบงานนี้"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sheetUrl = (date) => `${BASE}/job-sheet?guideId=G-901&date=${date}&slotIdx=0`;
async function open(role, date) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1400 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(await sessionCookie(data.users[role].email));
  await page.goto(sheetUrl(date), { waitUntil: "networkidle0" });
  await page.waitForSelector(APPROVAL, { timeout: 20000 });
  await pause(800);
  const text = await page.evaluate(() => document.body.innerText);
  const imgs = await page.$$eval("img", (xs) => xs.map((x) => x.getAttribute("src") || ""));
  return { page, errors, text, imgs };
}
try {
  const certsBefore = await prisma.expenseCertificate.count();
  const auditsBefore = await prisma.auditLog.count();
  for (const role of ["OPERATOR", "ADMIN"]) {
    const { page, errors, text, imgs } = await open(role, "2099-01-01");
    const approval = await page.$eval(APPROVAL, (x) => x.innerText);
    check(`${role}: the page loads without a crash`, errors.length === 0, errors.join(" | ").slice(0, 200));
    check(`${role}: approval shows status, approver and time`, approval.includes("อนุมัติแล้ว") && approval.includes("Op Example") && approval.includes("1 Jan 2099 14:05"), approval.replace(/\s+/g, " ").slice(0, 160));
    check(`${role}: no old statement, heading, certifier line or signature date`, LEGACY.every((re) => !re.test(text)));
    check(`${role}: no signature image`, !imgs.some((s) => /approver-signature|signature/i.test(s)), imgs.join(","));
    const ref = await page.$(REF);
    if (role === "ADMIN") {
      const refText = ref ? await page.$eval(REF, (x) => x.innerText) : "";
      const href = ref ? await page.$eval(`${REF} a`, (a) => a.getAttribute("href")).catch(() => null) : null;
      check("ADMIN: the certificate is named by number with its Drive link", refText.includes(CERT_NO) && href === DRIVE, refText.replace(/\s+/g, " ").slice(0, 160));
    } else {
      check("OPERATOR: nothing about the certificate is shown", !ref && !text.includes(CERT_NO));
    }
    await page.emulateMediaType("print");
    const printed = await page.$eval(APPROVAL, (x) => getComputedStyle(x).display !== "none");
    const refPrinted = ref ? await page.$eval(REF, (x) => { let n = x; while (n) { if (getComputedStyle(n).display === "none") return false; n = n.parentElement; } return true; }) : false;
    check(`${role}: approval prints; the certificate box does not`, printed && !refPrinted);
    if (SHOTS) { await page.emulateMediaType("screen"); await (await page.$(APPROVAL)).screenshot({ path: join(SHOTS, `approval-${role.toLowerCase()}.png`) }); if (ref) await ref.screenshot({ path: join(SHOTS, "certificate-reference-admin.png") }); }
    await page.close();
  }
  const { page, errors } = await open("ADMIN", "2099-01-02");
  const needText = await page.$eval(REF, (x) => x.innerText).catch(() => "");
  check("ADMIN, no certificate yet: says how to make one, creates nothing", errors.length === 0 && needText.includes("ยังไม่มีใบรับรอง") && needText.includes("สร้างร่าง") && needText.includes("ไม่สร้างให้อัตโนมัติ"), needText.replace(/\s+/g, " ").slice(0, 160));
  if (SHOTS) await (await page.$(REF)).screenshot({ path: join(SHOTS, "certificate-reference-none.png") });
  await page.close();
  check("opening job sheets created no certificate", (await prisma.expenseCertificate.count()) === certsBefore);
  check("no certificate audit was written", (await prisma.auditLog.count({ where: { action: { startsWith: "certificate." } } })) === 0 && auditsBefore >= 0);
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\njob sheet approval e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
