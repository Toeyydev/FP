// Company ADV → PEAK reconciliation on Payments → Advances, in a real browser (owner 2026-11-15):
//   1. the sync states read with the owner's names (Failed / Reconciliation required / Synced)
//   2. ADMIN: "Retry sync" on a failed item sends it back to the sender (Not synced), with history
//   3. ADMIN: "Resolve…" → "not in PEAK" + reason sends an uncertain item back; History shows why
//   4. "Re-check now" reads PEAK only (here: not configured → "Not checked") and changes nothing
//   5. the ACCOUNTANT sees the same controls; an OPERATOR sees the states but no controls
//   6. at 390 px the page has no sideways scroll
// PEAK is never called (no connection configured). All data invented.
// Run after `next build`:  node scripts/e2e/advance-peak-reconcile.mjs

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
const PORT = Number(process.env.E2E_PORT ?? 3993);
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
const DATE = "2099-05-10";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const CONFIG = JSON.stringify({ advanceAccountCode: "111100", advanceAccountSubId: "sub-advance", bankName: "Example Bank (e2e)", bankAccountCode: "111300", bankAccountSubId: "sub-bank", journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {} });

async function seed() {
  const tables = ["AuditLog", "ServiceStatus", "AdvancePeakDocumentLink", "AdvancePeakSync", "GuideAdvanceEntry", "GuideAdvanceRefund", "GuideAdvanceReceipt", "GuideAdvanceReturn", "GuideAdvance",
    "JobSheet", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const mk = (email, role, extra = {}) => prisma.user.create({ data: { email, displayName: `${role} Example`, fullName: `${role} Example`, role, state: "ACTIVE", passwordHash: hash, ...extra } });
  const users = { admin: await mk("admin-rec@example.test", "ADMIN"), acct: await mk("acct-rec@example.test", "ACCOUNTANT"), op: await mk("op-rec@example.test", "OPERATOR") };
  await mk("g-951@example.test", "GUIDE", { guideId: "G-951", peakContactId: "contact-e2e" });
  const adv = (n, amount, status, error, payload) => prisma.guideAdvance.create({ data: { guideId: "G-951", date: DATE, slotIdx: n, amount, paidAt: new Date(`${DATE}T03:00:00Z`), method: "bank", txRef: `TX-REC-${n}`, advanceNo: `FOLK-ADV-209905-00${n + 1}`, advanceDate: DATE, amountSatang: amount * 100, accountingPeriod: "2099-05", jobNo: `FOLK-BKK-20990510-0${n + 1}`, slipUrl: "https://example.test/slip" } })
    .then(async (a) => { await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${a.id}` }, data: { status, error, payload, documentNo: status === "POSTED" ? "JV-209905001" : null, nextAttemptAt: new Date(Date.now() + 3600_000) } }); return a; });
  const payload = { issuedDate: "20990510", contactId: "contact-e2e", reference: "x", journalEntries: [{ accountCode: "111100", accountSubId: "sub-advance", debit: "800.00", credit: "0.00" }, { accountCode: "111300", accountSubId: "sub-bank", debit: "0.00", credit: "800.00" }] };
  const failed = await adv(0, 1200, "BLOCKED", "PEAK refused: example error", null);
  const unsure = await adv(1, 800, "UNCERTAIN", "PEAK outcome needs reconciliation; automatic resend stopped", payload);
  const synced = await adv(2, 500, "POSTED", null, null);
  return { users, failed, unsure, synced };
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  // No PEAK credentials and auto-sync off: nothing here can reach PEAK.
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET, PEAK_ADVANCE_CONFIG: CONFIG,
      PEAK_ADVANCE_AUTO_SYNC: "", ADVANCE_WRITES_FROZEN: "", PEAK_CONNECT_ID: "", PEAK_CONNECT_KEY: "", PEAK_APPLICATION_CODE: "", PEAK_USER_TOKEN: "" },
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const item = (a) => prisma.advancePeakSync.findUniqueOrThrow({ where: { id: `ADVANCE:${a.id}` } });
async function open(user, width = 390) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, isMobile: width < 500, hasTouch: width < 500 });
  page.on("dialog", (d) => d.accept());
  await page.setCookie(await sessionCookie(user.email));
  await page.goto(`${BASE}/payments?view=advances`, { waitUntil: "networkidle0" });
  await pause(1500);
  return page;
}
const statusOf = (page, advanceNo) => page.evaluate((no) => {
  const row = [...document.querySelectorAll("tr")].find((tr) => tr.textContent.includes(no));
  const s = row?.querySelector(".js-peak-sync");
  return s ? { label: s.querySelector(".js-peak-sync-label")?.textContent, retry: !!s.querySelector(".js-peak-retry"), resolve: !!s.querySelector(".js-peak-resolve"), history: !!s.querySelector(".js-peak-history") } : null;
}, advanceNo);
const within = async (page, advanceNo, sel) => page.evaluateHandle((no, s) => [...document.querySelectorAll("tr")].find((tr) => tr.textContent.includes(no))?.querySelector(s), advanceNo, sel);
const tap = async (page, handle) => { await handle.evaluate((el) => el.scrollIntoView({ block: "center" })); await pause(150); await handle.click(); };

try {
  // 1, 5. Operator: states with the owner's names, no controls.
  {
    const page = await open(data.users.op);
    const f = await statusOf(page, "FOLK-ADV-209905-001"), u = await statusOf(page, "FOLK-ADV-209905-002"), s = await statusOf(page, "FOLK-ADV-209905-003");
    check("operator: the owner's names — Failed / Reconciliation required / Synced", f?.label === "Failed" && u?.label === "Reconciliation required" && s?.label === "Synced", JSON.stringify([f, u, s]));
    check("operator: no Retry, Resolve or History controls", !f?.retry && !u?.resolve && !f?.history);
    check("operator: no Re-check panel", !(await page.$(".js-peak-recheck")));
    await page.close();
  }
  // 5. Accountant sees the controls.
  {
    const page = await open(data.users.acct);
    const f = await statusOf(page, "FOLK-ADV-209905-001"), u = await statusOf(page, "FOLK-ADV-209905-002");
    check("accountant: Retry on the failed item, Resolve on the uncertain one, Re-check panel", f?.retry && u?.resolve && !!(await page.$(".js-peak-recheck")), JSON.stringify([f, u]));
    await page.close();
  }
  // 2–4, 6. Admin on a phone.
  {
    const page = await open(data.users.admin);
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("admin: no sideways page scroll at 390 px", wide <= 0, `${wide}px`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "advance-peak-reconcile-390.png"), fullPage: true });

    await tap(page, await within(page, "FOLK-ADV-209905-001", ".js-peak-retry"));
    await page.waitForFunction(() => [...document.querySelectorAll("tr")].some((tr) => tr.textContent.includes("FOLK-ADV-209905-001") && tr.querySelector(".js-peak-sync-label")?.textContent === "Not synced"), { timeout: 10000 }).catch(() => {});
    check("admin: Retry sync → the item is Not synced again (stored PENDING)", (await item(data.failed)).status === "PENDING" && (await statusOf(page, "FOLK-ADV-209905-001"))?.label === "Not synced", (await item(data.failed)).status);

    await tap(page, await within(page, "FOLK-ADV-209905-002", ".js-peak-resolve"));
    await page.waitForSelector(".js-peak-resolve-form");
    await page.click(".js-peak-notthere");
    await page.type(".js-peak-reason", "Searched PEAK by date and amount, not there");
    await tap(page, await page.$(".js-peak-resolve-submit"));
    await page.waitForFunction(() => [...document.querySelectorAll("tr")].some((tr) => tr.textContent.includes("FOLK-ADV-209905-002") && tr.querySelector(".js-peak-sync-label")?.textContent === "Not synced"), { timeout: 10000 }).catch(() => {});
    check("admin: Resolve → not in PEAK sends the uncertain item back (PENDING)", (await item(data.unsure)).status === "PENDING", (await item(data.unsure)).status);

    await tap(page, await within(page, "FOLK-ADV-209905-002", ".js-peak-history"));
    await page.waitForFunction(() => /Searched PEAK by date and amount/.test(document.querySelector(".js-peak-history-list")?.textContent ?? ""), { timeout: 8000 }).catch(() => {});
    const hist = await page.$eval(".js-peak-history-list", (el) => el.textContent).catch(() => "");
    check("admin: History shows who resolved it and why", /ADMIN/.test(hist) && /not in PEAK/.test(hist) && /Searched PEAK by date and amount/.test(hist), hist);

    const before = (await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } })).map((r) => `${r.id}:${r.status}:${r.updatedAt.getTime()}`);
    await tap(page, await page.$(".js-peak-recheck-run"));
    await page.waitForSelector(".js-peak-recheck-summary", { timeout: 15000 }).catch(() => {});
    const summary = await page.$eval(".js-peak-recheck-summary", (el) => el.textContent).catch(() => "");
    check("admin: Re-check reports (PEAK not reachable here → not checked)", /1 journal/.test(summary) && /not checked/.test(summary), summary);
    const after = (await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } })).map((r) => `${r.id}:${r.status}:${r.updatedAt.getTime()}`);
    check("admin: Re-check changed nothing", JSON.stringify(before) === JSON.stringify(after));
    check("admin: no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "advance-peak-reconcile-after-390.png"), fullPage: true });
    await page.close();
  }
  const outbound = readFileSync(OUTBOUND, "utf8");
  check("nothing called PEAK", !/peakengine|peakaccount/i.test(outbound), outbound.slice(0, 200));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nadvance PEAK reconcile e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
