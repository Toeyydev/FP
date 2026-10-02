// Approve, edit and Save on the job sheet page, in a real browser against a real server
// and database.
//
// Proves, on the page itself:
//   1. rows with no expense category are named before anyone opens a PEAK document
//   2. Approve → set the categories → Save saves (the approval moved the sheet's version,
//      and the page now sends the new one), and the confirmed payers' stamps are kept
//   3. the month's "Pay together" list follows the sheet without a reload: ready after
//      Approve, not ready after Unapprove, the new payout after Save
//   4. Unapprove → edit → Save saves
//   5. a sheet changed behind the page (another tab) is refused, the page says it was not
//      saved, never "Saved", and will not Save again until it is reloaded
//   6. the Payments page fetches its list again when it comes back into view
//   7. after a PEAK void, desktop and mobile show the recovery panel instead of
//      putting Sync to PEAK where the void action was
//
// Run after `next build`:  node scripts/e2e/jobsheet-version.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and
// AUTH_SECRET. Screenshots go to E2E_SCREEN_DIR if set.
//
// All data invented — this repo is public.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
const G = "G-983";
const DATE = "2025-03-10"; // past, so the month's payment list includes the job
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 2 } };
const STAMP = { paidBy: "guide", paidBySource: "operator", paidByBy: "u_ops_first", paidByAt: "2025-03-11T02:00:00.000Z" };
async function seed() {
  const tables = ["AuditLog", "Notification", "PeakAttachment", "ExpenseCertificate", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: bcrypt.hashSync(PASSWORD, 8) } });
  await prisma.user.create({ data: { email: "g983@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", pax: 4 } });
  // The real case's shape: confirmed payers, no categories.
  await prisma.jobSheet.create({ data: { ref: "FOLK-BKK-20250310-02", guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [],
    guideFee: { price: 1500, time: 1, whtPct: 3 }, certifiedAt: new Date("2025-03-11T01:00:00Z"),
    expenses: [{ description: "Water", price: 10, pax: 2, ...STAMP }, { description: "Bus", price: 15, pax: 3, ...STAMP }, { description: "Ferry", price: 5.5, pax: 4, ...STAMP }] } });
  return { op };
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

// ── helpers ──────────────────────────────────────────────────────────────────
const NOTE = 'textarea[placeholder^="Internal operations note"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sheetNow = () => prisma.jobSheet.findUniqueOrThrow({ where: KEY });
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const payTogether = (page) => page.$eval(".js-pay-together", (x) => x.innerText).catch(() => "");
const thisJobLine = async (page) => (await payTogether(page)).split("\n").find((l) => l.includes("(this job)")) ?? "";
const statusMsg = (page) => page.evaluate(() => [...document.querySelectorAll(".js-bar span")].map((s) => s.textContent).join(" | "));
async function clickButton(page, label) {
  const ok = await page.evaluate((label) => {
    const b = [...document.querySelectorAll(".js-bar button")].find((x) => x.textContent.trim() === label);
    if (!b || b.disabled) return false;
    b.click(); return true;
  }, label);
  if (!ok) throw new Error(`no enabled "${label}" button`);
}
const waitText = (page, re, timeout = 15000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout }, re.source);
async function setCategories(page, values) {
  const handles = await page.$$('select[title^="The stable category"]');
  for (let i = 0; i < values.length; i++) {
    await handles[i].select(values[i]);
    await pause(250); // one change at a time, as a person makes them
  }
}
async function setFee(page, value) {
  const input = await page.$('input[title="Agreed rate"]');
  await input.click({ clickCount: 3 });
  await input.type(String(value));
}

// ── the test ─────────────────────────────────────────────────────────────────
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  const puts = [];
  page.on("response", (r) => { if (r.url().endsWith("/api/jobsheet") && r.request().method() === "PUT") puts.push(r.status()); });
  await page.setCookie(await sessionCookie(data.op.email));
  await page.goto(`${BASE}/job-sheet?guideId=${G}&date=${DATE}&slotIdx=2`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".js-pay-together", { timeout: 20000 });

  // 1 — the warning
  const warn = await page.$eval(".js-category-missing", (x) => x.innerText).catch(() => "");
  check("rows with no category are named before any PEAK document", /Expense category required before creating a PEAK document/.test(warn) && /Row 1 · Water · ฿20\.00/.test(warn) && /Row 2 · Bus · ฿45\.00/.test(warn) && /Row 3 · Ferry · ฿22\.00/.test(warn), warn.replace(/\s+/g, " ").slice(0, 200));
  if (SHOTS) await (await page.$(".js-category-missing")).screenshot({ path: join(SHOTS, "category-missing.png") });
  const before = await thisJobLine(page);
  check("the month's list starts with this job not ready, ฿1,542", /1,542\.00/.test(before) && /not ready/.test(before), before);

  // 2 + 3 — Approve, then the list, then categories and Save on the new version
  await clickButton(page, "Approve");
  await waitText(page, /Approved ✓/);
  await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
  await page.waitForFunction(() => { const l = document.querySelector(".js-pay-together")?.innerText.split("\n").find((x) => x.includes("(this job)")) ?? ""; return l && !/not ready/.test(l); }, { timeout: 15000 }).catch(() => {});
  check("after Approve the list shows this job ready — no reload", !/not ready/.test(await thisJobLine(page)), await thisJobLine(page));
  const approvedVersion = (await sheetNow()).updatedAt.toISOString();
  await setCategories(page, ["meal", "transport", "transport"]);
  await clickButton(page, "Save");
  await waitText(page, /Saved ✓|Not saved/);
  let rows = (await sheetNow()).expenses;
  check("approve → set categories → Save saves", puts.at(-1) === 200 && rows.map((r) => r.expenseType).join(",") === "meal,transport,transport", `last PUT ${puts.at(-1)} · stored ${rows.map((r) => r.expenseType).join(",")} · selects ${(await page.$$('select[title^="The stable category"]')).length}`);
  check("the confirmed payers keep their stamps", rows.every((r) => r.paidByBy === "u_ops_first" && r.paidBy === "guide" && r.paidBySource === "operator"));
  check("the category warning is gone once the rows have one", !(await page.$(".js-category-missing")));
  check("the save moved the version on from the approval's", (await sheetNow()).updatedAt.toISOString() !== approvedVersion);

  // 3 — Save refreshes the list's payout
  await setFee(page, 1600);
  await clickButton(page, "Save");
  await waitText(page, /Saved ✓|Not saved/);
  await page.waitForFunction(() => /1,639\.00/.test(document.querySelector(".js-pay-together")?.innerText ?? ""), { timeout: 15000 }).catch(() => {});
  check("after Save the list carries the new payout (1,600 − 48 + 87 = ฿1,639) — no reload", /1,639\.00/.test(await thisJobLine(page)), await thisJobLine(page));

  // 4 — Unapprove → edit → Save
  await clickButton(page, "Unapprove");
  await waitText(page, /Approval removed/);
  await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
  await page.waitForFunction(() => /not ready/.test(document.querySelector(".js-pay-together")?.innerText.split("\n").find((x) => x.includes("(this job)")) ?? ""), { timeout: 15000 }).catch(() => {});
  check("after Unapprove the list shows this job not ready — no reload", /not ready/.test(await thisJobLine(page)), await thisJobLine(page));
  await page.type(NOTE, "checked with the guide");
  await clickButton(page, "Save");
  await waitText(page, /Saved ✓|Not saved/);
  check("unapprove → edit → Save saves", puts.at(-1) === 200 && (await sheetNow()).operatorNote === "checked with the guide", `last PUT ${puts.at(-1)} · note ${JSON.stringify((await sheetNow()).operatorNote)} · textareas ${(await page.$$(NOTE)).length}`);

  // 5 — changed behind the page
  await prisma.jobSheet.update({ where: KEY, data: { operatorNote: "saved in another tab" } });
  await page.type(NOTE, " (and more)");
  await clickButton(page, "Save");
  await page.waitForSelector(".js-save-problem", { timeout: 15000 }).catch(() => {});
  const problem = await page.$eval(".js-save-problem", (x) => x.innerText).catch(() => "");
  const msgNow = await statusMsg(page);
  check("a sheet changed in another tab is refused (409)", puts.at(-1) === 409 && (await sheetNow()).operatorNote === "saved in another tab", `last PUT ${puts.at(-1)}`);
  check("the page says it was NOT saved, with the reason", /Not saved/.test(problem) && /saved by someone else/.test(problem), problem.replace(/\s+/g, " ").slice(0, 200));
  check("nothing on the page says Saved", !/Saved ✓/.test(msgNow) && !/Saved ✓/.test(await bodyText(page)), msgNow);
  const saveDisabled = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^Save/.test(b.textContent.trim())).every((b) => b.disabled));
  check("Save stays disabled until the sheet is reloaded", saveDisabled);
  if (SHOTS) await (await page.$(".js-save-problem")).screenshot({ path: join(SHOTS, "not-saved-stale.png") });
  const reloaded = page.waitForResponse((r) => r.url().includes("/api/jobsheet?") && r.request().method() === "GET", { timeout: 15000 }).catch(() => null);
  await page.evaluate(() => [...document.querySelectorAll(".js-save-problem button")].find((b) => /Reload/.test(b.textContent))?.click());
  await reloaded;
  await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
  const noteAfter = await page.$eval(NOTE, (x) => x.value);
  check("Reload shows the sheet as saved and lets Save run again", !(await page.$(".js-save-problem")) && noteAfter === "saved in another tab", noteAfter);
  await page.type(NOTE, " — confirmed");
  await clickButton(page, "Save");
  await waitText(page, /Saved ✓|Not saved/);
  check("after the reload a Save goes through", puts.at(-1) === 200 && (await sheetNow()).operatorNote === "saved in another tab — confirmed", `last PUT ${puts.at(-1)}`);
  check("the job sheet page ran without a crash", errors.length === 0, errors.join(" | ").slice(0, 200));

  // 7 — the post-void state is safe at both operator viewport sizes. The server-side
  // confirmation is covered in the route suite; this proves the accidental one-click
  // path is not rendered after the page reloads.
  await prisma.jobSheet.update({ where: KEY, data: { peakSyncStatus: "VOIDED", peakDocumentId: null, peakDocumentNo: null, syncedAt: null } });
  for (const [label, width, height] of [["desktop", 1280, 1000], ["mobile", 390, 844]]) {
    await page.setViewport({ width, height });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".js-peak-voided", { timeout: 15000 });
    const panel = await page.$eval(".js-peak-voided", (x) => x.innerText);
    const ordinarySync = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sync to PEAK"));
    check(`${label}: a void shows Payments guidance and no one-click Sync button`, /previous PEAK document was voided/.test(panel) && /Open Payments/.test(panel) && /Sync again/.test(panel) && !ordinarySync, panel.replace(/\s+/g, " ").slice(0, 200));
  }

  // 6 — Payments fetches again when it comes back into view
  const pay = await browser.newPage();
  const listFetches = [];
  pay.on("request", (r) => { if (/\/api\/payments(\?|$)/.test(r.url()) && r.method() === "GET") listFetches.push(r.url()); });
  await pay.goto(`${BASE}/payments`, { waitUntil: "networkidle0" });
  const first = listFetches.length;
  await pay.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pause(1500);
  check("Payments fetches its list again when the page comes back into view", first >= 1 && listFetches.length > first, `${first} → ${listFetches.length}`);
  await pay.close();
  await page.close();
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\njob sheet version e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
