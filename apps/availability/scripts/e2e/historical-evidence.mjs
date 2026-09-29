// The historical evidence page in a real browser, against a real server and database.
//
// Proves four things the unit and integration suites cannot see from inside a route:
//
//   1. opening the page — list and detail — writes NOTHING, and neither the page nor
//      the server talks to PEAK or Google while doing it
//   2. a suggested Paid By is on screen but NOT in the database until an admin confirms
//   3. GUIDE, OPERATOR and ACCOUNTANT are turned away from the page and from its API
//   4. a NOT REQUIRED decision stops counting the moment the job sheet changes, and an
//      action quoting the old version of the sheet is refused
//   5. a NOT REQUIRED job resting on an older waiver can be taken on to a certificate:
//      the path is shown, the row is ticked and saved by the admin, and the job is READY
//
// Run after `next build`:  node scripts/e2e/historical-evidence.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser
// (`npm run browser:install`) and AUTH_SECRET. Screenshots go to E2E_SCREEN_DIR if set.
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
const PORT = Number(process.env.E2E_PORT ?? 3987);
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
async function seed() {
  const tables = ["AuditLog", "HistoricalEvidenceReview", "PeakAttachment", "ExpenseCertificate", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const users = {};
  for (const [role, email, name] of [["ADMIN", "admin@example.test", "Malee Testsuite"], ["OPERATOR", "op@example.test", "Op Example"], ["ACCOUNTANT", "acc@example.test", "Acc Example"], ["GUIDE", "g901@example.test", "Nok Example"]]) {
    users[role] = await prisma.user.create({ data: { email, displayName: name, fullName: name, role, state: "ACTIVE", passwordHash: hash, ...(role === "GUIDE" ? { guideId: "G-901" } : {}) } });
  }
  await prisma.user.create({ data: { email: "g902@example.test", displayName: "Somchai Sample", guideId: "G-902", role: "GUIDE", state: "ACTIVE" } });
  const e = (description, price, pax, over = {}) => ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });
  let n = 0;
  const sheet = (guideId, date, expenses, over = {}) => prisma.jobSheet.create({ data: {
    ref: `FOLK-BKK-${date.replace(/-/g, "")}-0${(n % 8) + 1}`, guideId, date, slotIdx: n++ % 6, tourId: "T-900", expenses, approvalStatus: "APPROVED", ...over } });
  const linked = await sheet("G-901", "2026-08-03", [e("Ferry (Inc. Guide)", 16, 5)]);
  const identity = ["Ferry (Inc. Guide)", 1600, 500, "transport", "guide"].join("|");
  const cert = await prisma.expenseCertificate.create({ data: { certificateNo: `CERT-${linked.ref}-01`, jobSheetId: linked.id, activeJobSheetId: linked.id, guideId: "G-901", jobRef: linked.ref, tourDate: linked.date, slotIdx: linked.slotIdx,
    status: "LINKED", payload: {}, payloadHash: "a".repeat(64), coveredRows: [{ index: 0, identity, description: "Ferry (Inc. Guide)", pax: 5, price: 16, amountSatang: 8000, category: "transport" }], totalSatang: 8000,
    source: "ADMIN_RECORDED", sourceSheetUpdatedAt: linked.updatedAt, pdfHash: "b".repeat(64), driveFileId: "drive_e2e_1", linkedAt: new Date("2026-09-20T02:00:00Z") } });
  await prisma.jobSheet.update({ where: { id: linked.id }, data: { expenses: [{ ...e("Ferry (Inc. Guide)", 16, 5), evidenceWaiver: { by: users.ADMIN.id, at: "2026-09-20T02:00:00Z", reason: "ใบรับรองแทนใบเสร็จ (ตัวอย่าง)", certificateId: cert.id, certificateNo: cert.certificateNo } }] } });
  await sheet("G-902", "2026-08-05", [e("Lunch", 120, 4, { expenseType: "meal", paidBy: "company" })]);
  const empty = await sheet("G-901", "2026-08-07", []);
  await sheet("G-902", "2026-08-10", [e("Bus (Inc. Guide)", 15, 6), e("Grand Palace", 500, null, { expenseType: "entrance", paidBy: "advance" })],
    { guideExpensesAt: new Date("2026-08-10T12:00:00Z"), guideExpenses: [{ description: "Bus (Inc. Guide)", price: 15, pax: 6, paidBy: "guide" }] });
  await sheet("G-901", "2026-08-12", [e("Tuk-tuk", 60, 2)]);
  const unpaid = await sheet("G-902", "2026-08-14", [e("Ferry (Inc. Guide)", 16, 4, { paidBy: undefined, paidBySource: undefined }), e("Water (Inc. Guide)", 10, 4, { expenseType: "meal", paidBy: undefined, paidBySource: undefined })]);
  await sheet("G-901", "2026-08-16", [e("Water (Inc. Guide)", 10, 5, { expenseType: "meal", paidBySource: undefined })]);
  await sheet("G-902", "2026-08-18", [e("Ferry (Inc. Guide)", 16, 3), e("Ferry (Inc. Guide)", 16, 3)]);
  await sheet("G-901", "2026-08-20", [e("Bus (Inc. Guide)", 15, 3)], { approvalStatus: null });
  const progress = await sheet("G-902", "2026-08-22", [e("Bus (Inc. Guide)", 15, 7)]);
  await prisma.expenseCertificate.create({ data: { certificateNo: `CERT-${progress.ref}-01`, jobSheetId: progress.id, activeJobSheetId: progress.id, guideId: "G-902", jobRef: progress.ref, tourDate: progress.date, slotIdx: progress.slotIdx,
    status: "READY_TO_ATTEST", payload: {}, payloadHash: "c".repeat(64), coveredRows: [], totalSatang: 10500, source: "ADMIN_RECORDED", sourceSheetUpdatedAt: progress.updatedAt } });
  const waived = await sheet("G-901", "2026-08-24", [e("Water (Inc. Guide)", 10, 3, { paidByBy: users.ADMIN.id, paidByAt: "2026-08-25T02:00:00Z",
    evidenceWaiver: { by: users.ADMIN.id, at: "2026-08-25T02:00:00Z", reason: "ร้านริมทางไม่ออกใบเสร็จ (ตัวอย่าง)" } })]);
  await sheet("G-901", "2026-09-30", [e("Ferry (Inc. Guide)", 16, 2)]); // after the cutoff: must not appear
  return { users, empty, unpaid, waived };
}

async function counts() {
  const [audits, reviews, certs, sheets] = await Promise.all([prisma.auditLog.count(), prisma.historicalEvidenceReview.count(), prisma.expenseCertificate.count(),
    prisma.jobSheet.findMany({ select: { id: true, updatedAt: true, expenses: true, approvalStatus: true }, orderBy: { id: "asc" } })]);
  return JSON.stringify({ audits, reviews, certs, sheets });
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
const QUEUE = 'table[aria-label="งานย้อนหลัง"]';
const PANEL = 'aside[aria-label="รายละเอียดงาน"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  // ── 3. everyone who is not ADMIN is turned away ──────────────────────────
  for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
    const page = await browser.newPage();
    await page.setCookie(await sessionCookie(data.users[role].email));
    await page.goto(`${BASE}/admin/historical-evidence`, { waitUntil: "networkidle0" });
    const onPage = page.url().includes("/admin/historical-evidence");
    const api = await page.evaluate(async (id) => [
      (await fetch("/api/admin/historical-evidence")).status,
      (await fetch(`/api/admin/historical-evidence/${id}`)).status,
    ], data.empty.id);
    check(`${role} is sent away from the page`, !onPage, page.url().replace(BASE, ""));
    check(`${role} gets 403 from the list and detail API`, api[0] === 403 && api[1] === 403, api.join(","));
    await page.close();
  }

  // ── 1. opening the page writes nothing and calls nothing outside ────────
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const external = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !u.startsWith("data:") && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) external.push(u);
  });
  await page.setCookie(await sessionCookie(data.users.ADMIN.email));
  writeFileSync(OUTBOUND, "");
  const before = await counts();
  await page.goto(`${BASE}/admin/historical-evidence`, { waitUntil: "networkidle0" });
  await page.waitForSelector(QUEUE);
  await page.select("select", "");
  await pause(300);
  const listed = await page.$$eval(`${QUEUE} tbody tr`, (rows) => rows.map((r) => r.innerText));
  check("the queue lists the eleven campaign jobs and not the one after the cutoff", listed.length === 11 && !listed.some((t) => t.includes("20260930")), `${listed.length} rows`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "01-queue.png"), fullPage: true });

  const refOn = (date) => page.evaluate((d, sel) => [...document.querySelectorAll(`${sel} tbody tr`)].find((r) => r.innerText.includes(d))?.querySelector(".mono")?.textContent, date, QUEUE);
  const open = async (ref) => {
    await page.evaluate((ref, sel) => [...document.querySelectorAll(`${sel} tbody tr`)].find((r) => r.innerText.includes(ref)).querySelector("button").click(), ref, QUEUE);
    await page.waitForSelector(`${PANEL} table`);
    await pause(400);
  };
  const readyRef = await refOn("2026-08-10");
  await open(readyRef);
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "02-detail-ready-guide-reported.png") });

  // ── 2. a suggestion is on screen and nowhere else ────────────────────────
  const unpaidRef = await refOn("2026-08-14");
  await open(unpaidRef);
  const panelText = await page.$eval(PANEL, (a) => a.innerText);
  const shown = await page.$$eval(`${PANEL} select[aria-label^="Paid By"]`, (s) => s.map((x) => x.value));
  check("the rules' suggestion is pre-selected and labelled as a suggestion", shown[0] === "GUIDE_PERSONAL" && panelText.includes("ข้อเสนอตามกฎ") && panelText.includes("ยังไม่บันทึกจนกว่าจะกดยืนยัน"), shown.join(","));
  check("a meal is not guessed", shown[1] === "" && panelText.includes("ประเภทนี้ระบบไม่เดา"));
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "03-detail-needs-review-suggestion.png") });

  const after = await counts();
  check("opening the list and two details wrote nothing", before === after);
  const stored = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.unpaid.id } })).expenses;
  check("the suggested payer is not in the database", stored.every((r) => r.paidBy === undefined && r.paidBySource === undefined && r.paidByBy === undefined));
  check("the browser made no request outside the app", external.length === 0, external.slice(0, 3).join(" "));
  const serverOut = readFileSync(OUTBOUND, "utf8").trim();
  check("the server made no request to PEAK or Google", !/peak|google/i.test(serverOut), serverOut.split("\n").slice(0, 3).join(" "));

  // Confirming is what writes it — and only then.
  await page.evaluate((sel) => {
    const s = document.querySelectorAll(`${sel} select[aria-label^="Paid By"]`)[1];
    s.value = "COMPANY_DIRECT"; s.dispatchEvent(new Event("change", { bubbles: true }));
  }, PANEL);
  await pause(200);
  await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.startsWith("ยืนยัน Paid By")).click(), PANEL);
  await pause(1500);
  const confirmed = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.unpaid.id } })).expenses;
  check("confirming writes the payer, stamped with the admin", confirmed[0].paidBy === "guide" && confirmed[1].paidBy === "company" && confirmed.every((r) => r.paidByBy === data.users.ADMIN.id && typeof r.paidByAt === "string"));
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "04-detail-after-confirm.png") });

  // ── 4. a decision is about one version of the sheet ──────────────────────
  const emptyRef = await refOn("2026-08-07");
  await open(emptyRef);
  const detail = await page.evaluate(async (id) => (await (await fetch(`/api/admin/historical-evidence/${id}`)).json()).job.classification, data.empty.id);
  await page.select(`${PANEL} select[aria-label="เหตุผลที่ไม่ต้องใช้ใบรับรอง"]`, "NO_EXPENSES");
  await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.startsWith("ยืนยัน NOT REQUIRED")).click(), PANEL);
  await pause(1500);
  const decided = await page.$eval(PANEL, (a) => a.innerText);
  check("NOT REQUIRED is recorded and counts as done", decided.includes("ADMIN ยืนยันแล้ว") && (await prisma.historicalEvidenceReview.count({ where: { jobSheetId: data.empty.id, decision: "NOT_REQUIRED" } })) === 1);

  // Somebody edits the job sheet afterwards.
  await prisma.jobSheet.update({ where: { id: data.empty.id }, data: { expenses: [{ description: "Taxi", price: 150, pax: 1, expenseType: "transport", paidBy: "guide", paidBySource: "operator" }] } });
  await page.goto(`${BASE}/admin/historical-evidence`, { waitUntil: "networkidle0" });
  await page.waitForSelector(QUEUE);
  await page.select("select", "");
  await pause(300);
  await open(emptyRef);
  const reopened = await page.$eval(PANEL, (a) => a.innerText);
  const status = await page.evaluate(async (id) => (await (await fetch(`/api/admin/historical-evidence/${id}`)).json()).job.classification, data.empty.id);
  check("after the sheet changed, the old NOT REQUIRED no longer counts", status.status === "NEEDS_REVIEW" && status.reopened === true && status.completed === false && reopened.includes("ใช้ไม่ได้แล้ว"), status.status);
  const stale = await page.evaluate(async (id, hash, version) => (await fetch(`/api/admin/historical-evidence/${id}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "not_required", snapshotHash: hash, reviewVersion: version, reasonCode: "NO_EXPENSES" }) })).status, data.empty.id, detail.snapshotHash, 1);
  check("an action quoting the old version of the sheet is refused", stale === 409, String(stale));
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "05-detail-reopened-after-edit.png") });

  // ── 5. NOT REQUIRED is not a dead end ────────────────────────────────────
  const waivedRef = await refOn("2026-08-24");
  await open(waivedRef);
  const nr = await page.$eval(PANEL, (a) => a.innerText);
  check("a NOT REQUIRED job on an older waiver shows the path to a certificate", nr.includes("เส้นทางสู่ใบรับรองแทนใบเสร็จ") && nr.includes("ให้ใบรับรองครอบคลุม"));
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "06-not-required-path.png") });
  const untouched = JSON.stringify((await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.waived.id } })).expenses);
  await page.click(`${PANEL} input[aria-label="ให้ใบรับรองครอบคลุมแถว 1"]`);
  await pause(200);
  check("ticking a row writes nothing until it is saved", JSON.stringify((await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.waived.id } })).expenses) === untouched);
  page.once("dialog", (d) => void d.accept());
  await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.startsWith("บันทึกรายการที่จะรับรอง")).click(), PANEL);
  await pause(1500);
  const saved = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.waived.id } })).expenses;
  const nowStatus = await page.evaluate(async (id) => (await (await fetch(`/api/admin/historical-evidence/${id}`)).json()).job.classification.status, data.waived.id);
  check("saving the tick stamps the row with the admin and the job becomes READY TO ISSUE",
    saved[0].certificateRequest?.by === data.users.ADMIN.id && saved[0].evidenceWaiver?.reason?.includes("ตัวอย่าง") && nowStatus === "READY_TO_ISSUE", nowStatus);
  const shownNow = await page.$eval(PANEL, (a) => a.innerText);
  check("the panel now offers the draft and says who chose the row", shownNow.includes("สร้างร่างใบรับรอง") && shownNow.includes("เลือกโดย Malee Testsuite"));
  check("no certificate was created by choosing rows", (await prisma.expenseCertificate.count({ where: { jobSheetId: data.waived.id } })) === 0);
  if (SHOTS) await (await page.$(PANEL)).screenshot({ path: join(SHOTS, "07-ready-after-selecting.png") });
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nhistorical evidence e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
