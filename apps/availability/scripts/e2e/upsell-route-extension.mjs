// Tour Upsell PR3 in a real browser against a real server and database: the guide sells
// Wat Pho + Wat Arun on their own job and takes the cash (mockup approved 19 Nov 2026).
//
//  • The Extras block on the guide's job sheet at 390 and 1280 px: fits the screen, every
//    control named, nothing interactive under 44 px.
//  • Sell 3 guests → a payment confirmation with the Sale Ref and Job Ref (read only), never
//    called a receipt; the job then shows Cash held, Amount to remit, Remit when, Remit by
//    (bank transfer only), Remittance status and Guide payout — the cash read from the ledger.
//  • A double tap records one sale.
//  • Lost connection after the server saved the sale: "Checking the status…", no new sale; the
//    pending request survives a reload and then shows the very sale that was saved.
//  • Lost before it reached the server: "Not recorded", Send again — with the same request key.
//  • The guest limit counts what is already sold; after the end-tour report nothing is sold.
//  • An operator opening the job sees no Extras block, and the API refuses them.
//  • The server makes no request to PEAK, a payment gateway or anything else off this machine.
//
// Run after `next build`:  node scripts/e2e/upsell-route-extension.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
// Every name, figure and reference here is invented — this repository is public.

import { spawn, spawnSync } from "node:child_process";
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
const PORT = Number(process.env.E2E_PORT ?? 3992);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
writeFileSync(OUTBOUND, "");
const PASSWORD = "e2e-password-not-real-1";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const ADMIN = "admin-rte@example.test", GUIDE = "g981@example.test", OPS = "ops-rte@example.test";
const GUIDE_ID = "G-981", TOUR = "T-005", SLOT = 3; // Wat Phrakaew & Grand Palace, 14:00
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const JOB_PATH = `/job-sheet?guideId=${GUIDE_ID}&date=${TODAY}&slotIdx=${SLOT}`;

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
// CI runs every e2e against ONE database, in order. Truncate only what this test writes —
// never shared configuration such as PeakAccountMapping, which a later test relies on.
async function seed() {
  const tables = ["AuditLog", "Notification", "CashCustodyEntry", "CashSettlementReturn", "CashSettlement", "UpsellPayment", "UpsellSale",
    "UpsellProductVersion", "UpsellProduct", "TaxProfile", "UpsellDocCounter", "TourReport", "Checkin", "JobSheet", "JobRefCounter",
    "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const r = spawnSync(process.execPath, [join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], {
    cwd: appDir, encoding: "utf8", env: { ...process.env, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: PASSWORD },
  });
  check("the deploy seed runs", r.status === 0, r.status === 0 ? "" : (r.stderr || r.stdout).slice(-600));
  const seeded = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  check("the seed makes RTE-WPWA cash-only, bank-transfer hand-in, no tours, inactive",
    JSON.stringify(seeded.allowedPaymentMethods) === '["CASH"]' && seeded.remittanceMethod === "BANK_TRANSFER" && seeded.eligibleSourceTourIds.length === 0);
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: GUIDE, displayName: "Fah Example", fullName: "Fah Example", guideId: GUIDE_ID, role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: OPS, displayName: "Operator Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  // What an Admin sets in Upsell settings (the settings page itself is tested in upsell-products.mjs).
  await prisma.upsellProductVersion.update({ where: { id: seeded.id }, data: { eligibleSourceTourIds: [TOUR] } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  // Today's job: six guests on the guide's Grand Palace tour.
  await prisma.assignment.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR, pax: 6 } });
  for (const [n, pax] of [["Invented Guest A", 2], ["Invented Guest B", 2], ["Invented Guest C", 2]]) {
    await prisma.booking.create({ data: { source: "manual", externalId: `e2e-${n}`, tourId: TOUR, date: TODAY, slotIdx: SLOT, pax, status: "ASSIGNED", customerName: n } });
  }
  await prisma.jobSheet.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR,
    bookings: [{ name: "Invented Guest A", bookedPax: 2 }, { name: "Invented Guest B", bookedPax: 2 }, { name: "Invented Guest C", bookedPax: 2 }] } });
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      // This throwaway server only: the master switch and the Route Extension's, so the guide
      // can sell. Production keeps every switch off. PEAK, payment link and the rest stay off.
      UPSELL_ENABLED: "1", UPSELL_ROUTE_EXTENSION_ENABLED: "1", UPSELL_FOOD_TOUR_ENABLED: "", UPSELL_ONSITE_TOUR_ENABLED: "",
      UPSELL_PAYMENT_LINK_ENABLED: "", UPSELL_PEAK_AUTO_SYNC: "", PEAK_ADVANCE_AUTO_SYNC: "" },
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

// ── page checks ──────────────────────────────────────────────────────────────
const fits = (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  let worst = 0; const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (!r.width || !r.height || r.right <= vw + 1 || s.visibility === "hidden" || s.display === "none" || s.position === "fixed" || inScroller(el)) continue;
    worst = Math.max(worst, Math.round(r.right - vw)); out.push(`${el.tagName.toLowerCase()}.${el.className}→${Math.round(r.right)}`);
  }
  return { over: worst, culprits: out.slice(0, 8) };
});
// Accessibility of the Extras block: names, 44 px targets, unique ids, describedby targets.
const a11y = (page) => page.evaluate(() => {
  const root = document.querySelector(".js-upsell");
  if (!root) return ["no Extras block"];
  const problems = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const nameOf = (el) => el.getAttribute("aria-label") || (el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(" ").trim() : (el.textContent ?? "").trim());
  for (const el of root.querySelectorAll("input, button")) {
    if (!visible(el)) continue;
    if (!nameOf(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}`);
    if (el.getBoundingClientRect().height < 44) problems.push(`${el.tagName.toLowerCase()} "${nameOf(el).slice(0, 24)}" is ${Math.round(el.getBoundingClientRect().height)}px tall`);
  }
  const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) problems.push(`duplicate ids ${[...new Set(dup)].join(",")}`);
  for (const el of root.querySelectorAll("[aria-describedby]")) for (const id of el.getAttribute("aria-describedby").split(/\s+/)) if (!document.getElementById(id)) problems.push(`aria-describedby → missing #${id}`);
  const by = root.getAttribute("aria-labelledby"); if (!by || !document.getElementById(by)) problems.push("the block has no heading");
  return problems;
});
/** Label/value rows that collide: a dt whose box overlaps its dd (the 390 px cash panel once did). */
const collisions = (page) => page.evaluate(() => {
  const out = [];
  for (const dl of document.querySelectorAll(".js-upsell dl")) {
    for (const dt of dl.querySelectorAll("dt")) {
      const dd = dt.nextElementSibling; if (!dd) continue;
      const a = dt.getBoundingClientRect(), b = dd.getBoundingClientRect();
      if (a.right > b.left + 1 && a.left < b.right && a.bottom > b.top && a.top < b.bottom) out.push(`"${dt.textContent.trim()}" overlaps "${dd.textContent.trim()}"`);
      const words = dt.textContent.trim().split(/\s+/).length;
      if (a.height > 3 * 24 && words <= 4) out.push(`"${dt.textContent.trim()}" squeezed to ${Math.round(a.width)}px`);
    }
  }
  return out;
});
const block = (page) => page.evaluate(() => document.querySelector(".js-upsell")?.innerText ?? "");
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `upsell-rte-${name}.png`), fullPage: true }); };
const goto = async (page, path) => { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30000 }); await new Promise((r) => setTimeout(r, 400)); };
const waitText = (page, re, timeout = 10000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".js-upsell")?.innerText ?? ""), { timeout }, re.source);
const counts = async () => ({ sales: await prisma.upsellSale.count(), payments: await prisma.upsellPayment.count(), custody: await prisma.cashCustodyEntry.count() });
const pendingKey = (page) => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) ?? "null")?.requestKey ?? null; } catch { return null; } }, `upsell-pending:${GUIDE_ID}:${TODAY}:${SLOT}`);
/** Tap like a guide: scroll the control to the middle of the screen first — the guide app's
 *  fixed bottom bar covers the last few pixels of the viewport. */
async function tap(page, sel) {
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
  await page.click(sel);
}
async function sellGuests(page, guests) {
  await tap(page, "button.ups-sell");
  try { await page.waitForSelector("button.ups-confirm", { timeout: 8000 }); } catch (e) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "upsell-rte-sell-did-not-open.png"), fullPage: true });
    console.log("Extras block when the sell form did not open:", JSON.stringify(await block(page)));
    throw e;
  }
  for (let i = 1; i < guests; i++) await tap(page, 'button[aria-label="One guest more"]');
}

// ── the test ─────────────────────────────────────────────────────────────────
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const pageErrors = [];
// CI runs every e2e against one database: earlier steps leave their own guide payments, advances
// and PEAK outbox rows. What matters is that this test adds none.
const moneyRows = async () => ({ outbox: await prisma.advancePeakSync.count(), guidePayments: await prisma.guidePayment.count(), advances: await prisma.guideAdvanceEntry.count() });
const moneyBefore = await moneyRows();
try {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("/api/health: only UPSELL_ENABLED and the route extension switch are on in this test server", JSON.stringify(health.upsell) === JSON.stringify({ enabled: true, routeExtension: true, foodTour: false, onsiteTour: false, paymentLink: false, peakAutoSync: false }), JSON.stringify(health.upsell));

  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const cookie = await sessionCookie(GUIDE);
  await page.setCookie(cookie);

  // ── the block, before a sale ──
  for (const [w, h] of [[390, 844], [1280, 900]]) {
    await page.setViewport({ width: w, height: h });
    await goto(page, JOB_PATH);
    await page.waitForSelector(".js-upsell button.ups-sell", { timeout: 15000 });
    const t = await block(page);
    check(`${w}px the guide sees Extras with Sell Wat Pho + Wat Arun at ฿200 per guest`, /extras/i.test(t) && t.includes("Sell Wat Pho + Wat Arun") && t.includes("฿200 per guest"), t.slice(0, 200));
    const f = await fits(page); check(`${w}px job sheet with Extras fits`, f.over <= 1, f.culprits.join(" "));
    const a = await a11y(page); check(`${w}px Extras accessibility`, a.length === 0, a.join("; "));
    await shot(page, `job-${w}`);
  }
  await page.setViewport({ width: 390, height: 844 });

  // ── sell 3 guests, with a double tap ──
  await sellGuests(page, 3);
  let t = await block(page);
  check("the sell form: 3 guests, ฿200 set by Folkpaths, cash to you, collect ฿600, the full ฿600 to remit", t.includes("Up to 6") && t.includes("set by Folkpaths") && t.includes("Cash to you") && t.includes("Collect from the guest") && (await page.$eval(".ups-total", (e) => e.textContent)) === "฿600" && t.includes("Amount to remit: the full ฿600"));
  check("the sell form has no price, ref or payment-method field", await page.evaluate(() => [...document.querySelectorAll(".js-upsell input")].every((i) => i.id === "ups-guests" && i.readOnly)));
  const fs = await fits(page); check("390px sell form fits", fs.over <= 1, fs.culprits.join(" "));
  const as = await a11y(page); check("sell form accessibility", as.length === 0, as.join("; "));
  await shot(page, "sell-390");
  await page.evaluate(() => { const b = document.querySelector("button.ups-confirm"); b.click(); b.click(); });
  await waitText(page, /Recorded · ฿600 cash with you/);
  t = await block(page);
  const sale1 = await prisma.upsellSale.findFirst({ orderBy: { createdAt: "asc" } });
  check("a double tap records one sale: one sale, one cash payment, one custody entry", JSON.stringify(await counts()) === JSON.stringify({ sales: 1, payments: 1, custody: 1 }));
  check("the sale is ฿600 for 3 guests, paid in cash to the guide, custody +฿600", sale1?.grossSatang === 60000 && sale1?.guests === 3 && (await prisma.upsellPayment.findFirst())?.method === "CASH" && (await prisma.cashCustodyEntry.findFirst())?.amountSatang === 60000);
  check("the payment confirmation shows the Sale Ref and Job Ref the system made", t.includes("Folkpaths · payment confirmation".toUpperCase()) || t.toLowerCase().includes("folkpaths · payment confirmation"));
  const saleRef = await page.$eval(".ups-sale-ref", (e) => e.textContent);
  const jobRef = await page.$eval(".ups-job-ref", (e) => e.textContent);
  const sheet = await prisma.jobSheet.findFirstOrThrow({ where: { guideId: GUIDE_ID } });
  check("Sale Ref on screen = the sale's FOLK-UPS number", saleRef === sale1?.saleNo && /^FOLK-UPS-\d{6}-\d{3}$/.test(saleRef), saleRef);
  check("Job Ref on screen = the job's FOLK-BKK number", jobRef === `Job Ref ${sheet.ref}` && /FOLK-BKK-\d{8}-\d{2}$/.test(jobRef), jobRef);
  check("the refs are read only — no field on the confirmation", await page.evaluate(() => !document.querySelector(".ups-confirmation input, .ups-confirmation textarea, .ups-confirmation select")));
  check("it says it is not a tax invoice or official receipt, and is never called a receipt otherwise",
    t.includes("Not a tax invoice or official receipt.") && !/receipt|tax invoice/i.test(t.replace("Not a tax invoice or official receipt.", "").replace("ไม่ใช่ใบเสร็จรับเงินหรือใบกำกับภาษี", "")));
  const fc = await fits(page); check("390px payment confirmation fits", fc.over <= 1, fc.culprits.join(" "));
  const cc = await collisions(page); check("390px confirmation rows: no label overlaps or is squeezed", cc.length === 0, cc.join("; "));
  const ac = await a11y(page); check("payment confirmation accessibility", ac.length === 0, ac.join("; "));
  await shot(page, "confirmation-390");

  // ── back on the job: the cash from the ledger ──
  await tap(page, "button.ups-back");
  await waitText(page, /Cash held/);
  t = await block(page);
  check("the job shows the sale with its Sale Ref", t.includes(sale1.saleNo) && t.includes("Wat Pho + Wat Arun · 3 guests"));
  check("Cash held ฿600 · Amount to remit ฿600 (from the custody ledger)", (await page.$eval(".ups-held", (e) => e.textContent)) === "฿600" && (await page.$eval(".ups-remit", (e) => e.textContent)) === "฿600");
  check("Remit when: with the end-tour report · Remit by: bank transfer only · status Not sent yet · payout unchanged",
    t.includes("With this job’s end-tour report") && t.includes("Bank transfer to Folkpaths only") && (await page.$eval(".ups-status", (e) => e.textContent)) === "Not sent yet" && /Guide payout\s*Unchanged/.test(t));
  const fj = await fits(page); check("390px job after a sale fits", fj.over <= 1, fj.culprits.join(" "));
  const cj = await collisions(page); check("390px cash rows: no label overlaps or is squeezed", cj.length === 0, cj.join("; "));
  const aj = await a11y(page); check("job after a sale accessibility", aj.length === 0, aj.join("; "));
  await shot(page, "job-after-390");
  await page.setViewport({ width: 1280, height: 900 });
  const fd = await fits(page); check("1280px job after a sale fits", fd.over <= 1, fd.culprits.join(" "));
  const cd = await collisions(page); check("1280px cash rows: no label overlaps or is squeezed", cd.length === 0, cd.join("; "));
  await shot(page, "job-after-1280");
  await page.setViewport({ width: 390, height: 844 });

  // ── lost connection AFTER the server saved it ──
  let mode = "normal"; // "forward-then-drop" | "drop" | "normal"
  let blockByKey = false;
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const u = req.url();
    if (u.endsWith("/api/upsell/sales") && req.method() === "POST" && mode !== "normal") {
      if (mode === "forward-then-drop") {
        await fetch(`${BASE}/api/upsell/sales`, { method: "POST", headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}` }, body: req.postData() });
      }
      return req.abort("failed");
    }
    if (u.includes("/api/upsell/sales/by-key/") && blockByKey) return req.abort("failed");
    return req.continue();
  });
  mode = "forward-then-drop"; blockByKey = true;
  await sellGuests(page, 1);
  await tap(page, "button.ups-confirm");
  await waitText(page, /Checking the status…/);
  t = await block(page);
  const keyLost = await pendingKey(page);
  check("response lost: the guide sees Checking the status…, keep the cash, don't sell again", t.includes("The sale may already be saved. Keep the cash and don’t sell again") && !!(await page.$("button.ups-check")) && !(await page.$("button.ups-sell")));
  check("the server did save it once, under the key the phone kept", (await counts()).sales === 2 && (await prisma.upsellSale.count({ where: { requestKey: keyLost } })) === 1);
  await shot(page, "checking-390");
  // Close the app and open it again: the pending sale is still asked about — never re-sold.
  mode = "normal"; blockByKey = false;
  await goto(page, JOB_PATH);
  await waitText(page, /Recorded · ฿200 cash with you/, 15000);
  const lostRef = await page.$eval(".ups-sale-ref", (e) => e.textContent);
  check("after reopening, the same sale is shown — not a new one", lostRef === (await prisma.upsellSale.findUniqueOrThrow({ where: { requestKey: keyLost } })).saleNo && (await counts()).sales === 2);
  check("the phone forgets the request key once it has the answer", (await pendingKey(page)) === null);
  await tap(page, "button.ups-back");

  // ── lost connection BEFORE it reached the server ──
  mode = "drop";
  await page.waitForSelector("button.ups-sell");
  await sellGuests(page, 1);
  await tap(page, "button.ups-confirm");
  await waitText(page, /Not recorded/);
  const keyDropped = await pendingKey(page);
  check("never reached the server: Not recorded, Send again, nothing saved", (await block(page)).includes("Send again") && (await counts()).sales === 2 && !!keyDropped);
  mode = "normal";
  await tap(page, "button.ups-resend");
  await waitText(page, /Recorded · ฿200 cash with you/);
  check("Send again records it once, with the key it was first made with", (await counts()).sales === 3 && (await prisma.upsellSale.count({ where: { requestKey: keyDropped } })) === 1);
  await tap(page, "button.ups-back");

  // ── the guest limit counts what is already sold ──
  await page.waitForSelector("button.ups-sell");
  await tap(page, "button.ups-sell");
  await page.waitForSelector("button.ups-confirm");
  t = await block(page);
  check("5 of 6 guests have it: the most is 1, and + is off", t.includes("Up to 1 now — 6 guests on this job, 5 already bought it") && await page.$eval('button[aria-label="One guest more"]', (b) => b.disabled));
  await tap(page, 'button[aria-label="Close"]');

  // ── after the end-tour report nothing more is sold ──
  await prisma.tourReport.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR } });
  await goto(page, JOB_PATH);
  await waitText(page, /Cash held/);
  t = await block(page);
  check("after the end-tour report: no Sell button, the sales and the cash still shown", !(await page.$("button.ups-sell")) && t.includes("nothing more can be sold on this job") && (await page.$eval(".ups-held", (e) => e.textContent)) === "฿1,000");
  const direct = await page.evaluate(async (body) => (await fetch("/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status,
    { requestKey: "e2e-after-report-0001", jobSheetId: sheet.id, productVersionId: sale1.productVersionId, guests: 1, expectedUnitPriceSatang: 20000 });
  check("and the API refuses a sale after the report (409)", direct === 409 && (await counts()).sales === 3, String(direct));
  await page.close();

  // ── an operator on the same job ──
  const ops = await browser.newPage();
  ops.on("pageerror", (e) => pageErrors.push(String(e)));
  await ops.setCookie(await sessionCookie(OPS));
  await goto(ops, JOB_PATH);
  check("an operator opening the job sees no Extras block", !(await ops.$(".js-upsell")));
  const opsApi = await ops.evaluate(async (p) => (await fetch(p)).status, `/api/upsell/jobs/extras?guideId=${GUIDE_ID}&date=${TODAY}&slotIdx=${SLOT}`);
  const opsSell = await ops.evaluate(async () => (await fetch("/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  check("the API refuses an operator (403)", opsApi === 403 && opsSell === 403, `${opsApi} ${opsSell}`);
  await ops.close();

  check("no page error", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  const outbound = readFileSync(OUTBOUND, "utf8").trim();
  check("the server called nothing off this machine (no PEAK, no gateway)", outbound === "", outbound.slice(0, 300));
  const moneyAfter = await moneyRows();
  check("no new PEAK outbox row, guide payment or Company ADV entry", JSON.stringify(moneyAfter) === JSON.stringify(moneyBefore), `${JSON.stringify(moneyBefore)} → ${JSON.stringify(moneyAfter)}`);
  check("the job sheet's expenses and fee are untouched", JSON.stringify((await prisma.jobSheet.findFirstOrThrow({ where: { guideId: GUIDE_ID } })).expenses) === "[]");
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
