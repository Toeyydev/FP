// The historical evidence page in a real browser, against a real server and database.
//
// Proves, on the two screens a guide opens on their phone (tour details, job sheet):
//   1. a guest with a readable number gets a "WhatsApp" button linking wa.me/<digits>,
//      big enough to tap (≥ 44 px), with the number beside it
//   2. a Thai local number is linked as 66…; a number with no country code gets no button
//   3. on a split departure a guide gets buttons only for their own guests, never the
//      other guide's; a cancelled booking gets none
//   4. the button is not printed, and opening the pages writes no phone onto the sheet
//   5. an operator viewing a guide's tour details still sees every guest's button
//
// Run after `next build`:  node scripts/e2e/guest-whatsapp.mjs
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
const PORT = Number(process.env.E2E_PORT ?? 3990);
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
const DATE = "2099-03-10";
async function seed() {
  const tables = ["AuditLog", "Notification", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const users = {};
  for (const [key, guideId, name] of [["A", "G-901", "Nok Example"], ["B", "G-902", "Somchai Sample"]]) {
    users[key] = await prisma.user.create({ data: { email: `${guideId.toLowerCase()}@example.test`, displayName: name, fullName: name, guideId, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
    await prisma.assignment.create({ data: { guideId, date: DATE, slotIdx: 0, tourId: "T-900", pax: 4 } });
  }
  users.OP = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  const mk = (ref, name, over) => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, customerName: name, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2, status: "ASSIGNED", ...over } });
  await mk("GYGTHAI", "Thai Local", { assignedGuideId: "G-901", phone: "081-010-0777" });
  await mk("GYGINTL", "Intl Guest", { assignedGuideId: "G-901", phone: "US+1 555 010 0123" });
  await mk("GYGBARE", "Bare Digits", { assignedGuideId: "G-901", phone: "5550100123" });
  await mk("GYGNONE", "No Phone", { assignedGuideId: "G-901", phone: null });
  await mk("GYGGONE", "Cancelled Guest", { assignedGuideId: "G-901", phone: "+39 333 0100 999", status: "CANCELLED" });
  await mk("GYGOTHR", "Other Guide Guest", { assignedGuideId: "G-902", phone: "+49 151 0100 888" });
  const rows = ["GYGTHAI", "GYGINTL", "GYGBARE", "GYGNONE", "GYGGONE"].map((r) => ({ name: r, bookingNo: r, bookedPax: 2, actualPax: null, tickets: "", status: "" }));
  const sheet = await prisma.jobSheet.create({ data: { ref: "FOLK-BKK-20990310-01", guideId: "G-901", date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", expenses: [], bookings: rows } });
  return { users, sheet };
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const buttons = (page) => page.$$eval('a[href^="https://wa.me/"]', (as) => as.map((a) => { const r = a.getBoundingClientRect(); return { href: a.getAttribute("href"), text: a.textContent.trim(), label: a.getAttribute("aria-label"), h: r.height, target: a.getAttribute("target"), next: (a.nextElementSibling?.textContent ?? "").trim() }; }));
try {
  for (const [path, label] of [[`/tour-details?date=${DATE}&slotIdx=0`, "tour details"], [`/job-sheet?guideId=G-901&date=${DATE}&slotIdx=0`, "job sheet"]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.users.A.email));
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
    await pause(1200);
    const b = await buttons(page);
    const hrefs = b.map((x) => x.href).sort();
    check(`${label}: loads without a crash`, errors.length === 0, errors.join(" | ").slice(0, 200));
    check(`${label}: exactly the two readable numbers get a button — Thai local as 66…, the Viator-labelled one as international`,
      JSON.stringify(hrefs) === JSON.stringify(["https://wa.me/15550100123", "https://wa.me/66810100777"]), hrefs.join(","));
    check(`${label}: the button says WhatsApp, is at least 44 px tall, opens without a new tab, and shows the number`,
      b.length === 2 && b.every((x) => /WhatsApp/.test(x.text) && x.h >= 44 && x.target === null && /^\+\d+$/.test(x.next)), JSON.stringify(b));
    const text = await page.evaluate(() => document.body.innerText);
    check(`${label}: the other guide's guest number is nowhere on the page`, !text.includes("0100 888") && !text.includes("49151") && !b.some((x) => x.href.includes("4915")));
    check(`${label}: no button for the cancelled booking`, !b.some((x) => x.href.includes("39333")));
    await page.emulateMediaType("print");
    const printed = await page.$$eval('a[href^="https://wa.me/"]', (as) => as.filter((a) => { let n = a; while (n) { if (getComputedStyle(n).display === "none") return false; n = n.parentElement; } return true; }).length);
    check(`${label}: the button is not printed`, printed === 0, String(printed));
    await page.emulateMediaType("screen");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label.replace(/ /g, "-")}-mobile.png`), fullPage: true });
    await page.close();
  }
  // An operator keeps seeing every guest's button on a guide's tour details.
  {
    const page = await browser.newPage();
    await page.setCookie(await sessionCookie(data.users.OP.email));
    await page.goto(`${BASE}/tour-details?date=${DATE}&slotIdx=0&guideId=G-901`, { waitUntil: "networkidle0" });
    await pause(1200);
    const hrefs = (await buttons(page)).map((x) => x.href).sort();
    check("an operator still sees every guest's button, including the other guide's", JSON.stringify(hrefs) === JSON.stringify(["https://wa.me/15550100123", "https://wa.me/491510100888", "https://wa.me/66810100777"]), hrefs.join(","));
    await page.close();
  }
  // Guide B opening guide A's job sheet gets nothing.
  const page = await browser.newPage();
  await page.setCookie(await sessionCookie(data.users.B.email));
  const res = await page.goto(`${BASE}/api/jobsheet?guideId=G-901&date=${DATE}&slotIdx=0`);
  const body = await res.text();
  check("another guide cannot fetch this job sheet or its contacts", res.status() === 403 && !body.includes("wa.me"), String(res.status()));
  await page.close();
  const after = await prisma.jobSheet.findUniqueOrThrow({ where: { id: data.sheet.id } });
  check("opening the pages wrote no phone onto the job sheet", after.updatedAt.getTime() === data.sheet.updatedAt.getTime() && !/wa\.me|0100/.test(JSON.stringify(after.bookings)));
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nguest WhatsApp e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
