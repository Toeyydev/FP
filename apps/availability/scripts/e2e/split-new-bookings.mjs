// A tour two guides share, in a real browser against a real server and database (owner,
// 22 Nov 2026): the Split dialog no longer offers "New bookings go to" — a booking that
// arrives later waits for an operator. On Bookings its card says it needs a guide (never the
// first guide's name) and offers each guide with their pax; "Give to" puts it on that guide's
// job sheet only. Desktop and 390px. The /jobs?split= deep link still opens the dialog.
// Run after `next build`:  node scripts/e2e/split-new-bookings.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates). All data invented — this repo is public.

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

const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 31 * 3600 * 1000).toISOString().slice(0, 10);
async function seed() {
  const tables = ["AuditLog", "Notification", "Booking", "Assignment", "Checkin", "JobSheet", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples", time: "13:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  const op = await prisma.user.create({ data: { email: "op-s@example.test", displayName: "Op Example", fullName: "Op Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  for (const [g, name] of [["G-981", "Fon Example"], ["G-982", "Mai Example"]]) {
    await prisma.user.create({ data: { email: `${g.toLowerCase()}@example.test`, displayName: name, fullName: name, guideId: g, role: "GUIDE", state: "ACTIVE" } });
  }
  for (const [g, ref, pax] of [["G-982", "E2E-SP-1", 6], ["G-981", "E2E-SP-2", 3]]) {
    await prisma.assignment.create({ data: { guideId: g, date: TODAY, slotIdx: 2, tourId: "T-900", pax } });
    await prisma.booking.create({ data: { source: "manual", tourId: "T-900", date: TODAY, slotIdx: 2, pax, customerName: `Guest ${ref}`, externalRef: ref, status: "OFFERED", assignedGuideId: g } });
  }
  // Tomorrow 13:30: Fon 3, Mai 6, and a booking nobody has yet.
  for (const [g, ref, pax] of [["G-981", "E2E-TM-1", 3], ["G-982", "E2E-TM-2", 6]]) {
    await prisma.assignment.create({ data: { guideId: g, date: TOMORROW, slotIdx: 2, tourId: "T-900", pax } });
    const b = await prisma.booking.create({ data: { source: "GetYourGuide", tourId: "T-900", date: TOMORROW, slotIdx: 2, pax, customerName: `Guest ${ref}`, externalRef: ref, status: "OFFERED", assignedGuideId: g } });
    await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-TM-${g}`, guideId: g, date: TOMORROW, slotIdx: 2, tourId: "T-900", status: "Confirmed", expenses: [],
      bookings: [{ name: b.customerName, bookingNo: ref, bookedPax: pax, actualPax: null, tickets: "", status: "" }] } });
  }
  await prisma.booking.create({ data: { source: "GetYourGuide", tourId: "T-900", date: TOMORROW, slotIdx: 2, pax: 2, customerName: "Guest E2E-NEW", externalRef: "E2E-NEW-2", status: "PENDING" } });
  return { op };
}

// ── server ───────────────────────────────────────────────────────────────────
async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    // Attaching to PEAK switched on, so the admin's button is on the page — opening it must still send nothing.
    env: { ...process.env, CERTIFICATE_PEAK_ATTACH: "1", OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET: process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789" },
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
const data = await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const openDialog = async (page) => {
  await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Split"), { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Split").click());
  await page.waitForFunction(() => /Split across guides/.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 20000 });
};
const openInbox = async (page) => {
  await page.goto(`${BASE}/bookings`, { waitUntil: "networkidle0" });
  // Expand every day so tomorrow's card is on the page.
  await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct/.test(b.innerText) && b.querySelector("b")).forEach((b) => { if (!b.nextElementSibling) b.click(); }));
  await page.waitForSelector(".js-needs-guide", { timeout: 20000 }).catch(async (e) => { console.log("PAGE:", (await page.evaluate(() => document.body.innerText)).slice(0, 1500)); throw e; });
};
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, isMobile: width < 600, hasTouch: width < 600 });
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.setCookie(await sessionCookie(data.op.email));
    await openDialog(page);
    check(`${width}px: the Split dialog has no "New bookings go to"`, !(await page.$(".js-split-new-to")) && !/New bookings go to/.test(await page.evaluate(() => document.querySelector(".modal").innerText)));
    check(`${width}px: no sideways scroll (Split)`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    await openInbox(page);
    const card = await page.$eval(".js-needs-guide", (x) => x.closest(".op-toolbar").innerText);
    const buttons = await page.$$eval(".js-give-to", (bs) => bs.map((b) => `${b.dataset.guide}|${b.innerText.trim()}|${b.disabled}`));
    check(`${width}px: the waiting booking's card says it needs a guide — never "Assigned to" the first guide`, /Needs a guide — 2 guides on this tour/i.test(card) && !/Assigned to/.test(card) && /E2E-NEW-2/.test(card), card.replace(/\s+/g, " ").slice(0, 300));
    check(`${width}px: Give to offers both guides with their pax`, buttons.length === 2 && buttons.some((b) => /^G-981\|G-981 Fon Example · 3\/12\|false$/.test(b)) && buttons.some((b) => /^G-982\|G-982 Mai Example · 6\/12\|false$/.test(b)), JSON.stringify(buttons));
    check(`${width}px: no sideways scroll (Bookings)`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(await page.evaluate(() => document.documentElement.scrollWidth)));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `needs-guide-${width}.png`), fullPage: true });

    if (width === 390) {
      // The deep link from the Understaffed card opens the same dialog (it used to close at once).
      const p2 = await browser.newPage();
      await p2.setCookie(await sessionCookie(data.op.email));
      await p2.goto(`${BASE}/jobs?split=${TODAY}&slot=2`, { waitUntil: "networkidle0" });
      check("the /jobs?split= link opens the Split dialog", !!(await p2.waitForFunction(() => /Split across guides/.test(document.querySelector(".modal")?.innerText ?? ""), { timeout: 15000 }).catch(() => null)));
      await p2.close();
    } else {
      // Give it to Mai: her sheet and pax only.
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/bookings/place"), { timeout: 20000 }),
        page.evaluate(() => document.querySelector('.js-give-to[data-guide="G-982"]').click()),
      ]);
      await page.waitForFunction(() => /Given to G-982/.test(document.body.innerText), { timeout: 20000 }).catch(() => {});
      const nb = await prisma.booking.findFirstOrThrow({ where: { externalRef: "E2E-NEW-2" } });
      const rows = async (g) => ((await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: g, date: TOMORROW, slotIdx: 2 } } })).bookings ?? []).map((r) => r.bookingNo);
      const pax = async (g) => (await prisma.assignment.findFirstOrThrow({ where: { guideId: g, date: TOMORROW, slotIdx: 2 } })).pax;
      check("Give to Mai: the booking is hers, on her job sheet, her pax 6 → 8", nb.assignedGuideId === "G-982" && (await rows("G-982")).includes("E2E-NEW-2") && (await pax("G-982")) === 8, JSON.stringify({ tag: nb.assignedGuideId, rows: await rows("G-982"), pax: await pax("G-982") }));
      check("Fon is untouched: same sheet, same pax", JSON.stringify(await rows("G-981")) === JSON.stringify(["E2E-TM-1"]) && (await pax("G-981")) === 3);
      check("the card no longer needs a guide", !(await page.$(".js-needs-guide")));
      check("audited as the operator", (await prisma.auditLog.count({ where: { action: "bookings.placed", actorId: data.op.id } })) === 1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `needs-guide-given.png`), fullPage: true });
    }
    check(`${width}px: no page error`, errors.length === 0, errors.join(" | ").slice(0, 200));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsplit new bookings e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
