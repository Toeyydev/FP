// The slip-correction page in a real browser, against a real server and database, with Google
// faked at the network layer (scripts/e2e/drive-fake.cjs) — never in production code.
//
// Proves:
//   1. GUIDE/OPERATOR/ACCOUNTANT are sent away from the page and refused by its API
//   2. opening the page writes nothing, and shows the before/after, the notice to withdraw
//      and the Drive rename
//   3. the button stays disabled until there is a reason and an explicit confirmation
//   4. pressing it corrects exactly one row, withdraws exactly one notice, leaves the
//      rightful guide's row untouched, and audits the session's ADMIN
//   5. a failed Drive rename is reported with a retry, and the retry renames the same file
//      id once — nothing is created or deleted in Drive
//
// Run after `next build`:  node scripts/e2e/slip-correction.mjs
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
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const url = process.env.DATABASE_URL ?? "";
if (!url || (/railway|amazonaws|supabase|\.com\b/i.test(url) && !/test/i.test(url))) {
  console.error("refusing to run: DATABASE_URL must be a throwaway test database (this truncates tables)");
  process.exit(2);
}
const PORT = Number(process.env.E2E_PORT ?? 3988);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
writeFileSync(OUTBOUND, "");
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
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
const DATE = "2026-07-15", WRONG = "fileWrongCopy0000000001", RIGHT = "fileRightful00000000002", MD5 = "0123456789abcdef0123456789abcdef";
const link = (id) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;
function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
async function seed() {
  const tables = ["AuditLog", "Notification", "GoogleCalendar", "PaymentBatchItem", "PaymentBatch", "PaymentTransaction", "PaymentEvidence", "GuidePaymentJob", "GuidePayment", "TourPayment", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const users = {};
  for (const [role, email, name] of [["ADMIN", "admin@example.test", "Malee Testsuite"], ["OPERATOR", "op@example.test", "Op Example"], ["ACCOUNTANT", "acc@example.test", "Acc Example"]]) {
    users[role] = await prisma.user.create({ data: { email, displayName: name, fullName: name, role, state: "ACTIVE", passwordHash: hash } });
  }
  users.GUIDE = await prisma.user.create({ data: { email: "g901@example.test", displayName: "Nok Example", guideId: "G-901", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  const g902 = await prisma.user.create({ data: { email: "g902@example.test", displayName: "Somchai Sample", guideId: "G-902", role: "GUIDE", state: "ACTIVE" } });
  await prisma.googleCalendar.create({ data: { userId: users.ADMIN.id, refreshToken: encrypt("e2e-refresh-token"), email: "admin@example.test" } });
  const paidAt = new Date("2026-08-20T07:07:11Z");
  const wrong = await prisma.tourPayment.create({ data: { guideId: "G-901", date: DATE, slotIdx: 2, tourId: "T-900", status: "PAID", paidAt, approvedBy: users.ADMIN.id, eslipUrl: link(WRONG) } });
  const right = await prisma.tourPayment.create({ data: { guideId: "G-902", date: DATE, slotIdx: 2, tourId: "T-900", status: "PAID", paidAt, approvedBy: users.ADMIN.id, eslipUrl: link(RIGHT), peakRef: "EXP-20990700001" } });
  await prisma.notification.createMany({ data: [
    { userId: users.GUIDE.id, kind: "job-change", message: `💸 Your payment has been transferred for 1 tour.\n\nBank slip: ${link(WRONG)}` },
    { userId: users.GUIDE.id, kind: "job-change", message: "An unrelated unread notice" },
    { userId: g902.id, kind: "job-change", message: `💸 Your payment has been transferred.\n\nBank slip: ${link(RIGHT)}` },
  ] });
  return { users, wrong, right };
}

// ── server ───────────────────────────────────────────────────────────────────
async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET, FAKE_DRIVE_LOG: DRIVE_LOG, FAKE_DRIVE_FAIL: "1",
      FAKE_DRIVE_FILES: JSON.stringify({ [WRONG]: { name: "G-901 Nok Example — 2026-07-15 (1 tour) — abc — e-slip.pdf", md5Checksum: MD5 }, [RIGHT]: { name: "G-902 Somchai Sample — 2026-07-15 (1 tour) — def — e-slip.pdf", md5Checksum: MD5 } }) },
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
const PANEL = 'section[aria-label="แก้สลิปที่แนบผิดงาน"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const counts = async () => JSON.stringify({
  pays: await prisma.tourPayment.findMany({ orderBy: { id: "asc" } }),
  notices: await prisma.notification.findMany({ orderBy: { id: "asc" } }),
  audits: await prisma.auditLog.count(),
});

const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const qs = new URLSearchParams({ guideId: "G-901", date: DATE, slotIdx: "2", tourPaymentId: data.wrong.id, driveFileId: WRONG, rightfulGuideId: "G-902" }).toString();
const PAGE = `${BASE}/admin/payment-corrections/detach-slip?${qs}`;
try {
  // ── 1. nobody but ADMIN ──────────────────────────────────────────────────
  for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
    const page = await browser.newPage();
    await page.setCookie(await sessionCookie(data.users[role].email));
    await page.goto(PAGE, { waitUntil: "networkidle0" });
    const onPage = page.url().includes("/admin/payment-corrections");
    const api = await page.evaluate(async (q, id) => [
      (await fetch(`/api/admin/payment-corrections/detach-slip?${q}`)).status,
      (await fetch("/api/admin/payment-corrections/detach-slip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry_rename", tourPaymentId: id }) })).status,
    ], qs, data.wrong.id);
    check(`${role} is sent away from the page`, !onPage, page.url().replace(BASE, ""));
    check(`${role} gets 403 from the API (plan and action)`, api[0] === 403 && api[1] === 403, api.join(","));
    await page.close();
  }

  // ── 2. opening the page writes nothing ──────────────────────────────────
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.setCookie(await sessionCookie(data.users.ADMIN.email));
  const before = await counts();
  await page.goto(PAGE, { waitUntil: "networkidle0" });
  await page.waitForSelector(`${PANEL} table[aria-label="ค่าก่อนและหลัง"]`);
  await pause(300);
  const shown = await page.$eval(PANEL, (s) => s.innerText);
  check("the page shows before/after, the untouched rightful row, the notice and the Drive rename",
    shown.includes("PAID") && shown.includes("PENDING") && shown.includes("G-902") && shown.includes("ไม่เปลี่ยน") && shown.includes("จะถูกถอน: 1") && shown.includes("เคยแนบผิดกับ G-901"));
  check("opening the page wrote nothing", (await counts()) === before);
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "01-plan.png") });

  // ── 3. the button needs a reason and a confirmation ─────────────────────
  const btn = async () => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.includes("ถอดสลิป"))?.disabled, PANEL);
  check("the button starts disabled", (await btn()) === true);
  await page.type(`${PANEL} textarea[aria-label="เหตุผลการแก้ไข"]`, "สลิปของไกด์อีกคนถูกแนบผิดกับงานนี้ (ทดสอบ)");
  check("a reason alone is not enough", (await btn()) === true);
  await page.click(`${PANEL} input[aria-label="ยืนยันการแก้ไข"]`);
  check("reason + confirmation enables it", (await btn()) === false);

  // ── 4. pressing it ──────────────────────────────────────────────────────
  const rightBefore = JSON.stringify(await prisma.tourPayment.findUniqueOrThrow({ where: { id: data.right.id } }));
  await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.includes("ถอดสลิป")).click(), PANEL);
  await page.waitForSelector(`${PANEL} [aria-label="ผลการแก้ไข"]`, { timeout: 15000 });
  await pause(500);
  const row = await prisma.tourPayment.findUniqueOrThrow({ where: { id: data.wrong.id } });
  check("the row is PENDING without the slip", row.status === "PENDING" && row.eslipUrl === null && row.paidAt === null, row.status);
  check("the rightful guide's row is byte-identical", JSON.stringify(await prisma.tourPayment.findUniqueOrThrow({ where: { id: data.right.id } })) === rightBefore);
  const notices = await prisma.notification.findMany();
  check("exactly the one notice linking the slip is withdrawn", notices.length === 2 && !notices.some((n) => n.userId === data.users.GUIDE.id && n.message.includes(WRONG)));
  const log = await prisma.auditLog.findFirst({ where: { action: "pay.slip_detached" } });
  check("the audit names the session's ADMIN, the reason and before/after", log?.actorId === data.users.ADMIN.id && log.detail.actorName === "Malee Testsuite" && log.detail.before.status === "PAID" && log.detail.after.status === "PENDING" && /ทดสอบ/.test(log.detail.reason));

  // ── 5. Drive failed once; the retry renames the same file, once ─────────
  const after = await page.$eval(PANEL, (s) => s.innerText);
  check("a failed rename is reported with a safe retry", after.includes("เปลี่ยนชื่อไม่สำเร็จ") && after.includes("ลองเปลี่ยนชื่อไฟล์อีกครั้ง"));
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "02-done-rename-failed.png") });
  await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.includes("ลองเปลี่ยนชื่อไฟล์อีกครั้ง")).click(), PANEL);
  await pause(1500);
  const final = await page.$eval(PANEL, (s) => s.innerText);
  const driveLog = readFileSync(DRIVE_LOG, "utf8").trim().split("\n");
  const patches = driveLog.filter((l) => l.startsWith("PATCH"));
  check("the retry renamed the same file id, and nothing was created or deleted in Drive",
    patches.length === 2 && patches[0] === `PATCH ${WRONG} FAILED` && patches[1].startsWith(`PATCH ${WRONG} G-902 — ${DATE} slot 2 — EXP-20990700001`) && !driveLog.some((l) => /^(POST|DELETE)/.test(l)) && !patches.some((l) => l.includes(RIGHT)), patches.join(" | "));
  check("the page now says the file is renamed", final.includes("เปลี่ยนชื่อแล้ว") && !final.includes("ลองเปลี่ยนชื่อไฟล์อีกครั้ง"));
  check("one correction, one failed and one successful rename in the audit",
    (await prisma.auditLog.count({ where: { action: "pay.slip_detached" } })) === 1 && (await prisma.auditLog.count({ where: { action: "drive.slip_rename_failed" } })) === 1 && (await prisma.auditLog.count({ where: { action: "drive.slip_renamed" } })) === 1);
  const outbound = readFileSync(OUTBOUND, "utf8");
  check("the server called no PEAK", !/peak/i.test(outbound));
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "03-renamed.png") });
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nslip correction e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
