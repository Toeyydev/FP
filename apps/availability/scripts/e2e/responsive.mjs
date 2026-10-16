// Every FolkOPS page at phone width (390 px): nothing makes the PAGE scroll sideways. Wide
// data tables may scroll inside their own box; the page itself must fit. Owner rule
// 2026-10-16: "ทุกอย่างจะต้อง responsive". In a real browser against a real server and DB.
//
// For each page that does not fit, it names the elements sticking out, so the fix is aimed.
//
// Run after `next build`:  node scripts/e2e/responsive.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
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

// ── data (invented) ──────────────────────────────────────────────────────────
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const PAST = new Date(Date.now() + 7 * 3600 * 1000 - 2 * 86400_000).toISOString().slice(0, 10);
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const DRIVE_LOG = join(appDir, ".e2e-drive.log");
writeFileSync(DRIVE_LOG, "");
const PEAK_CONFIG = "";
const G = "G-951";
async function seed() {
  const tables = ["AuditLog", "Notification", "Checkin", "TourReport", "TourPayment", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.tour.create({ data: { id: "T-900", name: "Riverside Temples and the Old Town Canals by Long-tail Boat", time: "08:30", durationMin: 180 } });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: "admin-rs@example.test", displayName: "Admin Example", fullName: "Admin Example", role: "ADMIN", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g951@example.test", displayName: "Nok Example", fullName: "Nok Example", guideId: G, role: "GUIDE", state: "ACTIVE", passwordHash: hash, phone: "0800000000" } });
  for (const d of [TODAY, PAST]) {
    await prisma.assignment.create({ data: { guideId: G, date: d, slotIdx: 0, tourId: "T-900", pax: 3 } });
    await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-RS-${d.slice(8)}`, guideId: G, date: d, slotIdx: 0, tourId: "T-900", status: "Confirmed",
      bookings: [{ name: "Guest With A Rather Long Name", bookingNo: "GYGEXAMPLE0001", bookedPax: 2, actualPax: null, tickets: "", status: "" }, { name: "Guest Two", bookingNo: "VIA-EXAMPLE-2", bookedPax: 1, actualPax: null, tickets: "", status: "" }],
      guideFee: { price: 1000, time: 1, whtPct: 3 },
      expenses: [{ description: "Grand Palace", expenseType: "entrance", price: 500, pax: 3, paidBy: "guide", paidBySource: "operator" }, { description: "Water (Inc. Guide)", expenseType: "meal", price: 10, pax: 4, paidBy: "guide", paidBySource: "operator" }] } });
  }
  await prisma.booking.create({ data: { source: "MANUAL", externalRef: "EX-RS-1", bookingNo: "EX-RS-1", leadName: "Guest With A Rather Long Name", pax: 2, date: TODAY, slotIdx: 0, tourId: "T-900", status: "ASSIGNED", assignedGuideId: G } }).catch(() => {});
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
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sheet = (d) => `/job-sheet?guideId=${G}&date=${d}&slotIdx=0`;
const OPS = ["/dashboard", "/bookings", "/board", "/jobs", "/process", "/guides", "/tours", "/blocked-slots", "/payments", "/payments?view=advances", "/payment-batches", "/payment-slips", "/expense-review", "/peak-sync", "/accounting-logs", "/reports", "/tour-log", "/admin", "/admin/create-job-sheets", "/meeting-points", "/product-map", "/tour-details", sheet(TODAY), sheet(PAST)];
const GUIDE = ["/", "/?view=week", "/profile", "/pay", sheet(TODAY), sheet(PAST)];
const ONLY = (process.env.RESPONSIVE_ONLY ?? "").split(",").filter(Boolean);
// html/body clip sideways overflow (globals.css), so a page that is too wide does not
// scroll — it is CUT. What counts is any element reaching past the screen's right edge
// that is not inside a box which scrolls sideways on purpose.
const measure = (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX)) return true; } return false; };
  const hidden = (el) => { const s = getComputedStyle(el); return s.visibility === "hidden" || s.display === "none" || s.position === "fixed"; };
  const out = [];
  let worst = 0;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= vw + 1 || hidden(el) || inScroller(el)) continue;
    worst = Math.max(worst, Math.round(r.right - vw));
    // Report the outermost offender of each branch only.
    const p = el.parentElement;
    const pr = p?.getBoundingClientRect();
    if (p && pr && pr.right > vw + 1 && !inScroller(p) && p !== document.body) continue;
    out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}→${Math.round(r.right)}`);
  }
  return { over: worst, culprits: out.slice(0, 12) };
});
try {
  for (const [who, email, pages] of [["admin", "admin-rs@example.test", OPS], ["guide", "g951@example.test", GUIDE]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setCookie(await sessionCookie(email));
    for (const path of pages) {
      if (ONLY.length && !ONLY.some((o) => path.startsWith(o))) continue;
      try {
        await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 600));
        const m = await measure(page);
        check(`${who} ${path} fits a phone`, m.over <= 1, m.over > 1 ? `${m.over}px cut off · ${m.culprits.join(" ")}` : "");
        if (process.env.RESPONSIVE_DEEP && m.over > 1) console.log((await page.evaluate(readFileSync(process.env.RESPONSIVE_DEEP, "utf8"))).join("\n"));
        if (SHOTS && (m.over > 1 || process.env.RESPONSIVE_SHOT_ALL)) await page.screenshot({ path: join(SHOTS, `responsive-${who}${path.replace(/[^a-z0-9]+/gi, "-")}.png`), fullPage: !!process.env.RESPONSIVE_SHOT_ALL });
      } catch (e) { check(`${who} ${path} loads`, false, String(e).slice(0, 200)); }
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
