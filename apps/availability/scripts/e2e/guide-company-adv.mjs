// A guide's Company ADV, in a real browser against a real server and database.
//
// Owner decisions 2026-11-11. Proves, as the GUIDE at phone width (390 px):
//   1. a transferred bank advance shows only "Company ADV", "✓ Transferred", the amount,
//      "🔒 Read-only" and "To return ฿X" — on the page AND in what the server sends
//   2. no ADV number, bank reference, transfer date, slip link or note reaches the guide's
//      browser: not the job sheet JSON, not the page, not the PDF
//   3. no advance, or a reversed one, shows no card and no "Transferred"
//   4. every ADV write is refused to the guide on the server (create, delete, reverse,
//      settle, acknowledge, voucher), and the advance row is unchanged afterwards
//   5. the guide can still record their own return through the card (slip + reference),
//      which lowers "To return" and leaves the advance's amount untouched
//   6. an operator still receives the full ledger
//
// Run after `next build`:  node scripts/e2e/guide-company-adv.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET. Google is faked at the network layer (drive-fake.cjs). All data invented.

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
const PORT = Number(process.env.E2E_PORT ?? 3994);
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
const DATE = "2099-04-14";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const SLIP = join(tmpdir(), "folkops-e2e-return-slip.png");
writeFileSync(SLIP, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
function encrypt(plain) {
  const key = scryptSync(AUTH_SECRET, "folkpath-enc-v1", 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
// Everything a guide must never receive. Each is unique to this seed.
const SECRETS = ["FOLK-ADV-209904-001", "FOLK-ADV-209904-002", "TX-SECRET-77", "SECRET-NOTE-ABC", "SECRET-SLIP-XYZ", "SECRET-PURPOSE-Q", "2099-04-12"];

async function seed() {
  const tables = ["AuditLog", "ServiceStatus", "Checkin", "TourReport", "PushSubscription", "Notification", "GoogleCalendar",
    "AdvancePeakDocumentLink", "AdvancePeakSync", "GuideAdvanceEntry", "GuideAdvanceRefund", "GuideAdvanceReceipt", "GuideAdvanceReturn", "GuideAdvance",
    "ExpenseCertificate", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-902", name: "Canal Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const admin = await prisma.user.create({ data: { email: "admin-adv@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  const guide = await prisma.user.create({ data: { email: "g-931@example.test", displayName: "Guide Example", fullName: "Guide Example", guideId: "G-931", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("e2e-refresh-token"), email: "admin-adv@example.test" } });
  const sheets = [];
  for (const slotIdx of [0, 1, 2]) {
    await prisma.assignment.create({ data: { guideId: "G-931", date: DATE, slotIdx, tourId: "T-902", pax: 2 } });
    sheets.push(await prisma.jobSheet.create({ data: { ref: `FOLK-BKK-20990414-0${slotIdx + 1}`, guideId: "G-931", date: DATE, slotIdx, tourId: "T-902", status: "Confirmed",
      expenses: [{ description: "Temple tickets", price: 500, pax: 2, expenseType: "entrance" }], bookings: [{ name: "Guest Example", bookingNo: `VIA-ADV-${slotIdx}`, bookedPax: 2, actualPax: null, tickets: "", status: "" }] } }));
  }
  const base = { guideId: "G-931", date: DATE, method: "bank", advanceDate: "2099-04-12", paidAt: new Date("2099-04-12T03:00:00Z"), accountingPeriod: "2099-04", allowedCategories: ["entrance"], note: "SECRET-NOTE-ABC", purpose: "SECRET-PURPOSE-Q", slipUrl: "https://drive.google.com/SECRET-SLIP-XYZ" };
  const live = await prisma.guideAdvance.create({ data: { ...base, slotIdx: 0, amount: 5000, amountSatang: 500000, txRef: "TX-SECRET-77", advanceNo: "FOLK-ADV-209904-001", jobNo: sheets[0].ref } });
  const reversed = await prisma.guideAdvance.create({ data: { ...base, slotIdx: 1, amount: 800, amountSatang: 80000, txRef: "TX-SECRET-78", advanceNo: "FOLK-ADV-209904-002", jobNo: sheets[1].ref, reversedAt: new Date(), reversalReason: "sent to the wrong account" } });
  return { guide, admin, live, reversed, sheets };
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), "--require", join(appDir, "scripts/e2e/drive-fake.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", FAKE_DRIVE_LOG: DRIVE_LOG, FOLKPATHS_DRIVE_EMAIL: "admin-adv@example.test",
      ADVANCE_WRITES_FROZEN: "", PEAK_ADVANCE_AUTO_SYNC: "" },
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const leaks = (text) => SECRETS.filter((s) => text.includes(s));
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const rowOf = (a) => prisma.guideAdvance.findUniqueOrThrow({ where: { id: a.id }, select: { amountSatang: true, settledSatang: true, reversedAt: true, acknowledgedAt: true, txRef: true, advanceNo: true } });
try {
  const gCookie = await sessionCookie(data.guide.email);
  const asGuide = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie: `${gCookie.name}=${gCookie.value}` } });
  const before = await rowOf(data.live);

  // 1–2. What the server sends the guide.
  const api = await (await asGuide(`/api/jobsheet?guideId=G-931&date=${DATE}&slotIdx=0`)).text();
  const j = JSON.parse(api);
  check("server: the guide gets no advance ledger", j.advance === undefined, Object.keys(j).join(","));
  check("server: the guide gets amount + Transferred + To return only", JSON.stringify(j.guideAdvance) === JSON.stringify({ amount: 5000, transferred: true, toReturn: 5000, frozen: false }), JSON.stringify(j.guideAdvance));
  check("server: no ADV number, reference, date, slip, note or purpose in the guide's job sheet response", leaks(api).length === 0, leaks(api).join(","));
  const pdf = await (await asGuide(`/api/jobsheet/pdf?guideId=G-931&date=${DATE}&slotIdx=0`)).text();
  check("PDF: the guide's copy has the Company ADV card", /Company ADV/.test(pdf) && /Transferred/.test(pdf), "");
  check("PDF: no ADV number, reference, date, slip or note in the guide's copy", leaks(pdf).length === 0, leaks(pdf).join(","));
  const mob = await (await asGuide(`/api/mobile/advance?date=${DATE}&slotIdx=0`)).text();
  check("mobile: no ADV number, reference, date, slip or note (session cookie is not a mobile token — 401 is fine)", leaks(mob).length === 0, leaks(mob).join(","));

  // 3. Reversed / none → no card.
  for (const [slotIdx, label] of [[1, "a reversed advance"], [2, "no advance"]]) {
    const t = await (await asGuide(`/api/jobsheet?guideId=G-931&date=${DATE}&slotIdx=${slotIdx}`)).text();
    check(`server: ${label} → no card, no Transferred`, JSON.parse(t).guideAdvance === null && !/Transferred/.test(t) && leaks(t).length === 0, JSON.stringify(JSON.parse(t).guideAdvance));
  }

  // 4. Every ADV write refused to the guide.
  const fd = () => { const f = new FormData(); f.append("kind", "advance"); f.append("guideId", "G-931"); f.append("date", DATE); f.append("slotIdx", "0"); f.append("amount", "9999"); f.append("method", "bank"); f.append("txRef", "TX-NEW"); f.append("allowedCategories", "entrance"); f.append("file", new Blob([readFileSync(SLIP)], { type: "image/png" }), "s.png"); return f; };
  const refused = [
    ["create an advance from the job sheet", await asGuide("/api/jobsheet/advance", { method: "POST", body: fd() }), [403]],
    ["delete an advance", await asGuide(`/api/jobsheet/advance?id=${data.live.id}`, { method: "DELETE" }), [403]],
    ["create an advance on Payments", await asGuide("/api/advances", { method: "POST", body: fd() }), [401, 403]],
    ["reverse the advance", await asGuide(`/api/advances/${data.live.id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "guide trying" }) }), [401, 403]],
    ["settle expenses against it", await asGuide(`/api/advances/${data.live.id}/settle-expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), [401, 403]],
    ["change its categories", await asGuide(`/api/advances/${data.live.id}/categories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowedCategories: ["meal"] }) }), [401, 403, 405]],
    ["acknowledge it", await asGuide(`/api/advances/${data.live.id}/acknowledge`, { method: "POST" }), [410]],
    ["open its voucher", await asGuide(`/api/advances/${data.live.id}/voucher`), [403]],
  ];
  for (const [what, res, ok] of refused) check(`server refuses the guide: ${what}`, ok.includes(res.status), String(res.status));
  const afterWrites = await rowOf(data.live);
  check("the advance row is unchanged after the refused writes", JSON.stringify(afterWrites) === JSON.stringify(before), JSON.stringify(afterWrites));
  check("no new advance was created", (await prisma.guideAdvance.count()) === 2);

  // 1, 5. The page, as the guide on a phone.
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setCookie(gCookie);
  await page.goto(`${BASE}/job-sheet?guideId=G-931&date=${DATE}&slotIdx=0`, { waitUntil: "networkidle0" });
  await pause(1200);
  check("page: loads without a crash", errors.length === 0, errors.join(" | ").slice(0, 200));
  const card = await page.$eval(".js-guide-adv", (el) => el.innerText).catch(() => "");
  check("page: the card reads Company ADV · ✓ Transferred · ฿5,000.00 · 🔒 Read-only · To return ฿5,000.00",
    /Company ADV/.test(card) && /✓ Transferred/.test(card) && /฿5,000\.00/.test(card) && /Read-only/.test(card) && /To return/.test(card), card.replace(/\n/g, " | "));
  const html = await page.content();
  check("page: no ADV number, reference, date, slip or note anywhere in the guide's page", leaks(html).length === 0, leaks(html).join(","));
  check("page: the old ledger and its Record advance / acknowledge controls are not there", !(await page.$(".advance-settlement")) && !(await page.$(".js-advance-record")) && !/I received it/i.test(html));
  check("page: an Upload slip / receipt button is offered", !!(await page.$(".js-guide-adv-upload")));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("page: no sideways scroll at 390 px", wide <= 0, `${wide}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-company-adv-390.png"), fullPage: true });

  // 5. The guide records their own return through the card.
  // Centre each control first: at phone width the fixed bottom nav covers the screen's foot.
  const tap = async (sel) => { await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" })); await pause(150); await page.click(sel); };
  await tap(".js-guide-adv-record-return");
  await page.waitForSelector(".js-guide-return-form");
  const amountBox = await page.$(".js-guide-return-form input[type=number]");
  await amountBox.click({ clickCount: 3 }); await amountBox.type("1000");
  await page.type(".js-guide-return-form input:not([type])", "TX-RETURN-1");
  await page.$eval(".js-guide-return-form", (el) => el.scrollIntoView({ block: "center" }));
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(".js-guide-return-form label.btn")]);
  await chooser.accept([SLIP]);
  const returnResponse = page.waitForResponse((r) => r.url().includes("/api/jobsheet/advance") && r.request().method() === "POST", { timeout: 20000 }).then(async (r) => `${r.status()} ${(await r.text()).slice(0, 300)}`).catch((e) => `no response: ${e.message}`);
  await tap(".js-guide-return-submit");
  const returnResult = await returnResponse;
  await page.waitForFunction(() => /Return recorded/.test(document.querySelector(".js-guide-adv")?.innerText ?? ""), { timeout: 15000 }).catch(() => {});
  const after = await page.$eval(".js-guide-adv", (el) => el.innerText).catch(() => "");
  check("return: the card says it is recorded and To return drops to ฿4,000.00", /Return recorded/.test(after) && /฿4,000\.00/.test(after), `${returnResult} || ${after.replace(/\n/g, " | ")}`);
  const receipts = await prisma.guideAdvanceReceipt.findMany({ select: { amountSatang: true, status: true, bankRef: true } });
  check("return: one CLAIMED return of ฿1,000 is recorded for the office to check", receipts.length === 1 && receipts[0].amountSatang === 100000 && receipts[0].status === "CLAIMED", JSON.stringify(receipts));
  const afterReturn = await rowOf(data.live);
  check("return: the advance's amount, status and reference are untouched", afterReturn.amountSatang === before.amountSatang && afterReturn.reversedAt === null && afterReturn.txRef === before.txRef && afterReturn.acknowledgedAt === null, JSON.stringify(afterReturn));
  check("return: still no secret on the page after the update", leaks(await page.content()).length === 0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "guide-company-adv-after-return-390.png"), fullPage: true });
  await page.close();

  // 6. The operator still sees the ledger.
  const aCookie = await sessionCookie(data.admin.email);
  const ops = await (await fetch(`${BASE}/api/jobsheet?guideId=G-931&date=${DATE}&slotIdx=0`, { headers: { cookie: `${aCookie.name}=${aCookie.value}` } })).json();
  check("operator: still receives the full ledger with the ADV number", ops.advance?.advances?.[0]?.advanceNo === "FOLK-ADV-209904-001" && ops.guideAdvance === undefined, JSON.stringify(ops.advance?.advances?.[0]?.advanceNo));
  const opsVoucher = await fetch(`${BASE}/api/advances/${data.live.id}/voucher`, { headers: { cookie: `${aCookie.name}=${aCookie.value}` } });
  check("operator: can still open the voucher", opsVoucher.status !== 403 && opsVoucher.status !== 401, String(opsVoucher.status));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nguide Company ADV e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
