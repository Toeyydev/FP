// Tour Upsell in a real browser against a real server and database: the guide sells Wat Pho +
// Wat Arun on their own job by ticking "ขายเพิ่ม +฿200" after each customer's name and pressing
// ONE "Send to Admin · ยืนยันเก็บเงินแล้ว ฿X" (owner, 20 Nov 2026; mockup v11).
//
//  • The tick sits in each customer's own row, after the name, not the arrival tick; no separate
//    Sell card or second guest list; ticking records nothing; 390 and 1280 px fit; named controls.
//  • Send records ONE sale for every ticked guest (2 of A's 2 + 1 of B's), queues the PEAK receipt,
//    is never a reversal; a double tap records one sale. Admin sees it at once in Extras cash.
//  • One ref.โอนเงิน — the Job Ref — before and after the report; "recorded in error" stays
//    under แก้ไข… until opened on purpose, and Cancel closes it.
//  • Lost connection after the server saved the sale: "Checking the status…", no new sale; the
//    pending request survives a reload and then shows the very sale that was saved.
//  • Lost before it reached the server: "Not recorded", Send again — with the same request key.
//  • The guest limit counts what is already sold; after the end-tour report nothing is sold.
//  • An operator opening the job sees no Extras, and the API refuses them.
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
  const people = [["Invented Guest A", 2, "E2E-BK-A", "GetYourGuide", "Invented Grand Palace only (rate)"], ["Invented Guest B", 2, "E2E-BK-B", "Invented Palace Morning Tour", null], ["Invented Guest C", 2, "E2E-BK-C", null, null]];
  for (const [n, pax, ref, product, rate] of people) {
    await prisma.booking.create({ data: { source: "manual", externalId: `e2e-${n}`, confirmationCode: ref, tourId: TOUR, date: TODAY, slotIdx: SLOT, pax, status: "ASSIGNED", customerName: n, productName: product, rateTitle: rate } });
  }
  await prisma.jobSheet.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR,
    bookings: people.map(([n, pax, ref]) => ({ name: n, bookingNo: ref, bookedPax: pax })) } });
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
    // A checkbox is hit through its whole label (the row), which is what has to be 44 px.
    const target = el.type === "checkbox" && el.closest("label") ? el.closest("label") : el;
    if (target.getBoundingClientRect().height < 44) problems.push(`${el.tagName.toLowerCase()} "${nameOf(el).slice(0, 24)}" is ${Math.round(target.getBoundingClientRect().height)}px tall`);
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
/** Rows in the money tables that point at this test's own sales, payments, custody, job or guide —
 *  by any column: the row's whole JSON is searched for every id and ref. Not a count of the whole
 *  table, which other CI steps share. */
async function moneyRowsReferencing() {
  const sales = await prisma.upsellSale.findMany({ select: { id: true, saleNo: true } });
  const payments = await prisma.upsellPayment.findMany({ select: { id: true } });
  const custody = await prisma.cashCustodyEntry.findMany({ select: { id: true } });
  const sheet = await prisma.jobSheet.findFirstOrThrow({ where: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT } });
  const needles = [...sales.flatMap((x) => [x.id, x.saleNo]), ...payments.map((x) => x.id), ...custody.map((x) => x.id), sheet.id, sheet.ref, GUIDE_ID]
    .filter(Boolean).map((x) => `%${x}%`);
  const out = {};
  for (const table of ["AdvancePeakSync", "GuidePayment", "GuidePaymentJob", "GuideAdvance", "GuideAdvanceEntry"]) {
    const exists = await prisma.$queryRawUnsafe(`SELECT to_regclass('"${table}"') IS NOT NULL AS ok`);
    if (!exists[0].ok) { out[table] = "missing table"; continue; }
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}" t WHERE to_jsonb(t)::text LIKE ANY ($1::text[])`, needles);
    out[table] = n;
  }
  return { needles: needles.length, sales: sales.length, refs: out };
}
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
/** The guide's customer rows: where the Extras tick sits against the name and the arrival tick. */
const customerRows = (page) => page.$$eval(".gs-cust > li", (lis) => lis.map((li) => {
  const name = li.querySelector("b"), pick = li.querySelector(".ups-row-pick, .ups-row-sold"), arrived = li.querySelector(".js-arrived");
  const nr = name?.getBoundingClientRect(), pr = pick?.getBoundingClientRect(), lr = li.getBoundingClientRect();
  return { name: name?.textContent ?? "", pick: li.querySelector(".ups-row-pick")?.textContent?.trim() ?? null,
    pickAfterName: !!(nr && pr && (pr.top >= nr.bottom - 2 || pr.left >= nr.right - 1)),
    sameRow: !!(pr && pr.top >= lr.top - 1 && pr.bottom <= lr.bottom + 1),
    arrivedLabel: arrived?.textContent?.trim().slice(0, 6) ?? null,
    arrivedColor: arrived ? getComputedStyle(arrived.querySelector("input")).accentColor : null,
    pickColor: li.querySelector(".ups-row-pick input") ? getComputedStyle(li.querySelector(".ups-row-pick input")).accentColor : null };
}));
const rowHandle = async (page, ref) => {
  for (const li of await page.$$(".gs-cust > li")) if ((await li.evaluate((e) => e.innerText)).includes(ref)) return li;
  throw new Error(`no customer row ${ref}`);
};
const rowText = async (page, ref) => (await rowHandle(page, ref)).evaluate((e) => e.innerText);
const rowHas = async (page, ref, sel) => !!(await (await rowHandle(page, ref)).$(sel));
/** Tick "ขายเพิ่ม" on a customer's row and raise its how-many to n. */
async function tick(page, ref, n) {
  const li = await rowHandle(page, ref);
  const box = await li.$(".ups-row-pick input");
  await box.evaluate((b) => b.scrollIntoView({ block: "center" }));
  await box.click();
  for (let i = 1; i < n; i++) await (await li.$('.ups-row-qty button[aria-label="One guest more"]')).click();
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
  check("/api/health: only UPSELL_ENABLED and the route extension switch are on in this test server", JSON.stringify(health.upsell) === JSON.stringify({ enabled: true, routeExtension: true, foodTour: false, onsiteTour: false, walkInQr: false, paymentLink: false, peakAutoSync: false }), JSON.stringify(health.upsell));

  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const cookie = await sessionCookie(GUIDE);
  await page.setCookie(cookie);

  // ── the job, before a sale: the tick after each customer's name ──
  for (const [w, h] of [[390, 844], [1280, 900]]) {
    await page.setViewport({ width: w, height: h });
    await goto(page, JOB_PATH);
    await page.waitForSelector(".gs-cust .ups-row-pick", { timeout: 15000 });
    const rows = await customerRows(page);
    check(`${w}px each customer row carries its own "ขายเพิ่ม +฿200" tick, after the name, in the same row`,
      rows.length === 3 && rows.every((r) => r.pick === "ขายเพิ่ม +฿200" && r.pickAfterName && r.sameRow), JSON.stringify(rows));
    check(`${w}px the Extras tick is not the arrival tick (own label and colour)`, rows.every((r) => r.arrivedLabel === "มาแล้ว" && r.pickColor !== r.arrivedColor), JSON.stringify(rows.map((r) => [r.arrivedColor, r.pickColor])));
    check(`${w}px no separate Sell card or second guest list; no Send while nothing is ticked`,
      !(await page.$("button.ups-sell")) && !(await page.$(".ups-guests")) && !(await page.$(".ups-send-admin")) && (await block(page)).includes("Ticking alone records nothing"));
    check(`${w}px no "recorded in error" text on the main path`, !/recorded in error|บันทึกผิด/i.test(await page.evaluate(() => document.body.innerText)));
    const f = await fits(page); check(`${w}px job sheet with the ticks fits`, f.over <= 1, f.culprits.join(" "));
    const a = await a11y(page); check(`${w}px Extras accessibility`, a.length === 0, a.join("; "));
    await shot(page, `job-${w}`);
  }
  await page.setViewport({ width: 390, height: 844 });

  // ── tick A (2 of 2) and B (1 of 2): nothing is recorded by ticking ──
  await tick(page, "E2E-BK-A", 2);
  await tick(page, "E2E-BK-B", 1);
  let t = await block(page);
  const sendText = await page.$eval("button.ups-send-admin", (b) => b.textContent);
  check("the one Send: Send to Admin · ยืนยันเก็บเงินแล้ว ฿600, 3 guests, the total from the server price", sendText === "Send to Admin · ยืนยันเก็บเงินแล้ว ฿600" && (await page.$eval(".ups-total", (e) => e.textContent)) === "฿600" && t.includes("3 guests"), sendText);
  check("a booking of 2: a small how-many appears only once ticked (2 of 2)", (await rowText(page, "E2E-BK-A")).includes("of 2") && !(await rowText(page, "E2E-BK-C")).includes("of 2"));
  check("ticking sent nothing: no sale, payment or cash entry", JSON.stringify(await counts()) === JSON.stringify({ sales: 0, payments: 0, custody: 0 }));
  check("no other box to tick and no reversal form", !(await page.$(".ups-affirm")) && !(await page.$(".ups-reversal-form")));
  const fs = await fits(page); check("390px with ticks fits", fs.over <= 1, fs.culprits.join(" "));
  const as = await a11y(page); check("ticks + Send accessibility", as.length === 0, as.join("; "));
  await shot(page, "ticked-390");
  await page.evaluate(() => { const b = document.querySelector("button.ups-send-admin"); b.click(); b.click(); });
  await waitText(page, /ส่งให้ Admin แล้ว · 3 guests · ฿600/);
  t = await block(page);
  const sale1 = await prisma.upsellSale.findFirst({ orderBy: { createdAt: "asc" } });
  check("a double tap records one sale: one sale, one cash payment, one custody entry", JSON.stringify(await counts()) === JSON.stringify({ sales: 1, payments: 1, custody: 1 }));
  check("the sale is ฿600 for 3 guests, paid in cash to the guide, custody +฿600", sale1?.grossSatang === 60000 && sale1?.guests === 3 && (await prisma.upsellPayment.findFirst())?.method === "CASH" && (await prisma.cashCustodyEntry.findFirst())?.amountSatang === 60000);
  check("the PEAK receipt is queued with the sale (the existing transaction)", (await prisma.upsellPeakEvent.count({ where: { eventKind: "RECEIPT", sourceId: sale1.id } })) === 1);
  check("Send is not a reversal: no reversal row", (await prisma.upsellSaleReversal.count()) === 0);
  const allocs = await prisma.upsellSaleAllocation.findMany({ where: { saleId: sale1.id }, orderBy: { bookingRef: "asc" } });
  check("the sale names its guests by the server's booking: 2 from E2E-BK-A, 1 from E2E-BK-B, with the button's words, the guide and the time", JSON.stringify(allocs.map((a) => [a.bookingRef, a.guests])) === JSON.stringify([["E2E-BK-A", 2], ["E2E-BK-B", 1]])
    && allocs.every((a) => a.cashAckText === "ยืนยันเก็บเงินแล้ว ฿600 · Cash received" && !!a.cashAckById && !!a.cashAckAt), JSON.stringify(allocs.map((a) => [a.bookingRef, a.guests, a.cashAckText])));
  check("the confirmation lists each booking's guests", t.includes("Invented Guest A") && t.includes("E2E-BK-A") && t.includes("2 × ฿200") && t.includes("Invented Guest B"));
  const saleRef = await page.$eval(".ups-sale-ref", (e) => e.textContent);
  const jobRef = await page.$eval(".ups-job-ref", (e) => e.textContent);
  const sheet = await prisma.jobSheet.findFirstOrThrow({ where: { guideId: GUIDE_ID } });
  check("Sale Ref on screen = the sale's FOLK-UPS number", saleRef === sale1?.saleNo && /^FOLK-UPS-\d{6}-\d{3}$/.test(saleRef), saleRef);
  check("Job Ref on screen = the job's FOLK-BKK number", jobRef === `Job Ref ${sheet.ref}` && /FOLK-BKK-\d{8}-\d{2}$/.test(jobRef), jobRef);
  check("it says ยืนยันการชำระเงินเท่านั้น and nothing about receipts or tax invoices", t.includes("ยืนยันการชำระเงินเท่านั้น") && !/receipt|tax invoice|ใบเสร็จ|ใบกำกับ/i.test(t));
  const fc = await fits(page); check("390px confirmation fits", fc.over <= 1, fc.culprits.join(" "));
  const cc = await collisions(page); check("390px confirmation rows: no label overlaps or is squeezed", cc.length === 0, cc.join("; "));
  await shot(page, "sent-390");

  // ── back on the job: the rows say what was sold; one ref.โอนเงิน ──
  await tap(page, "button.ups-back");
  await waitText(page, /Cash held/);
  t = await block(page);
  check("rows show what was sold instead of a toggle: A ขายเพิ่มแล้ว ฿400 · 2 (no tick left), B ขายเพิ่มแล้ว ฿200 and 1 more can be ticked",
    (await rowText(page, "E2E-BK-A")).includes("ขายเพิ่มแล้ว ฿400 · 2") && !(await rowHas(page, "E2E-BK-A", ".ups-row-pick")) && (await rowText(page, "E2E-BK-B")).includes("ขายเพิ่มแล้ว ฿200") && (await rowHas(page, "E2E-BK-B", ".ups-row-pick")));
  check("the sale is listed as ส่งให้ Admin แล้ว with its Sale Ref", t.includes(sale1.saleNo) && t.includes("ส่งให้ Admin แล้ว"));
  const refShown = await page.$$eval(".ups-transfer-ref-code", (xs) => xs.map((x) => x.textContent));
  check("ONE ref.โอนเงิน, copyable: the Job Ref", JSON.stringify(refShown) === JSON.stringify([sheet.ref]) && !!(await page.$("button.ups-copy-ref")), JSON.stringify(refShown));
  check("Cash held ฿600 · To hand in ฿600 (from the custody ledger)", (await page.$eval(".ups-held", (e) => e.textContent)) === "฿600" && (await page.$eval(".ups-remit", (e) => e.textContent)) === "฿600");
  check("the next step is one short line (report, then transfer + slip)", (await page.$$(".ups-next")).length === 1);
  // "Recorded in error" lives under แก้ไข… — closed until opened on purpose; Cancel closes it.
  check("แก้ไข… is closed: no reversal form, no red text on the main path", !(await page.$(".ups-reversal-form")) && (await page.$$eval("details.ups-sale-edit", (ds) => ds.every((d) => !d.open))));
  await page.$eval("details.ups-sale-edit summary", (s) => { s.scrollIntoView({ block: "center" }); s.click(); });
  await tap(page, "button.ups-error-reversal");
  await page.waitForSelector(".ups-reversal-form");
  await page.waitForFunction(() => /I confirm I did not receive/.test(document.querySelector(".ups-reversal-form")?.innerText ?? ""), { timeout: 10000 });
  const form = await page.$eval(".ups-reversal-form", (e) => e.innerText);
  check("opened explicitly: a clear Thai title that denies the cash, the exact statement and a reason", form.includes("แจ้งว่าบันทึกผิด · ไม่ได้รับเงินสดสำหรับรายการนี้") && /I confirm I did not receive/.test(form) && !!(await page.$(".ups-reversal-send[disabled]")), form.slice(0, 200));
  await shot(page, "edit-open-390");
  await page.$$eval(".ups-reversal-form button", (bs) => bs.find((b) => b.textContent === "Cancel").click());
  await page.waitForFunction(() => !document.querySelector(".ups-reversal-form") && [...document.querySelectorAll("details.ups-sale-edit")].every((d) => !d.open));
  check("Cancel closes it; nothing was sent", (await prisma.upsellSaleReversal.count()) === 0);
  const fj = await fits(page); check("390px job after a sale fits", fj.over <= 1, fj.culprits.join(" "));
  const cj = await collisions(page); check("390px cash rows: no label overlaps or is squeezed", cj.length === 0, cj.join("; "));
  const aj = await a11y(page); check("job after a sale accessibility", aj.length === 0, aj.join("; "));
  await shot(page, "job-after-390");
  await page.setViewport({ width: 1280, height: 900 });
  const fd = await fits(page); check("1280px job after a sale fits", fd.over <= 1, fd.culprits.join(" "));
  const rd = await customerRows(page);
  check("1280px the sold chip and the tick sit in the customer's own row", rd.every((r) => r.sameRow), JSON.stringify(rd));
  await shot(page, "job-after-1280");
  await page.setViewport({ width: 390, height: 844 });

  // ── Admin sees it at once (Finance › Extras cash) ──
  const desk = await (await browser.createBrowserContext()).newPage();
  desk.on("pageerror", (e) => pageErrors.push(String(e)));
  await desk.setCookie(await sessionCookie(ADMIN));
  await desk.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await goto(desk, "/upsell-cash");
  await desk.waitForSelector(".js-cash-sale", { timeout: 15000 });
  const adminRow = await desk.$eval(".js-cash-sale", (e) => e.innerText);
  check("Admin's Extras cash lists the sale: guide, job, bookings × guests, ฿600, รอไกด์โอน (cash still with the guide)", adminRow.includes(sale1.saleNo) && adminRow.includes(GUIDE_ID) && adminRow.includes(sheet.ref) && adminRow.includes("E2E-BK-A × 2") && adminRow.includes("E2E-BK-B × 1") && adminRow.includes("฿600") && adminRow.includes("รอไกด์โอน"), adminRow);
  const fa = await fits(desk); check("390px Admin cash-sales list fits", fa.over <= 1, fa.culprits.join(" "));
  await shot(desk, "admin-sales-390");
  await desk.close();

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
  await tick(page, "E2E-BK-C", 1);
  await tap(page, "button.ups-send-admin");
  await waitText(page, /Checking the status…/);
  t = await block(page);
  const keyLost = await pendingKey(page);
  check("response lost: the guide sees Checking the status…, keep the cash, don't sell again", t.includes("The sale may already be saved. Keep the cash and don’t sell again") && !!(await page.$("button.ups-check")) && !(await page.$("button.ups-send-admin")));
  check("the server did save it once, under the key the phone kept", (await counts()).sales === 2 && (await prisma.upsellSale.count({ where: { requestKey: keyLost } })) === 1);
  await shot(page, "checking-390");
  mode = "normal"; blockByKey = false;
  await goto(page, JOB_PATH);
  await waitText(page, /ส่งให้ Admin แล้ว · 1 guest · ฿200/, 15000);
  const lostRef = await page.$eval(".ups-sale-ref", (e) => e.textContent);
  check("after reopening, the same sale is shown — not a new one", lostRef === (await prisma.upsellSale.findUniqueOrThrow({ where: { requestKey: keyLost } })).saleNo && (await counts()).sales === 2);
  check("the phone forgets the request key once it has the answer", (await pendingKey(page)) === null);
  await tap(page, "button.ups-back");

  // ── lost connection BEFORE it reached the server ──
  mode = "drop";
  await tick(page, "E2E-BK-B", 1);
  await tap(page, "button.ups-send-admin");
  await waitText(page, /Not recorded/);
  const keyDropped = await pendingKey(page);
  check("never reached the server: Not recorded, Send again, nothing saved", (await block(page)).includes("Send again") && (await counts()).sales === 2 && !!keyDropped);
  mode = "normal";
  await tap(page, "button.ups-resend");
  await waitText(page, /ส่งให้ Admin แล้ว · 1 guest · ฿200/);
  check("Send again records it once, with the key it was first made with", (await counts()).sales === 3 && (await prisma.upsellSale.count({ where: { requestKey: keyDropped } })) === 1);
  await tap(page, "button.ups-back");

  // ── the guest limit counts what is already sold ──
  await waitText(page, /Cash held/);
  const left = await page.$$eval(".gs-cust .ups-row-pick input", (xs) => xs.filter((x) => !x.disabled).length);
  check("5 of 6 guests have it: A and B show what was sold with no tick; only C can still be ticked (1 left)",
    left === 1 && !(await rowHas(page, "E2E-BK-A", ".ups-row-pick")) && !(await rowHas(page, "E2E-BK-B", ".ups-row-pick")) && (await rowHas(page, "E2E-BK-C", ".ups-row-pick")), String(left));

  // ── after the end-tour report nothing more is sold ──
  await prisma.tourReport.create({ data: { guideId: GUIDE_ID, date: TODAY, slotIdx: SLOT, tourId: TOUR } });
  await goto(page, JOB_PATH);
  await waitText(page, /Cash held/);
  const closedRows = await page.$$eval(".gs-cust > li", (lis) => lis.map((li) => [!!li.querySelector(".ups-row-pick"), !!li.querySelector(".ups-row-sold"), li.querySelector(".ups-row-closed input")?.disabled ?? null]));
  check("after the end-tour report: no tick to sell on any row; each row shows what was sold (or a disabled ส่งรายงานแล้ว); the cash still shown",
    closedRows.every(([pick, sold, closed]) => !pick && (sold || closed === true)) && (await rowText(page, "E2E-BK-C")).includes("ขายเพิ่มแล้ว ฿200") && (await page.$eval(".ups-held", (e) => e.textContent)) === "฿1,000", JSON.stringify(closedRows));
  const refAfter = await page.$$eval(".ups-transfer-ref-code", (xs) => xs.map((x) => x.textContent));
  check("the same one ref.โอนเงิน in the hand-in (no second code to get)", JSON.stringify(refAfter) === JSON.stringify([sheet.ref]) && !(await page.$(".ups-prepare")), JSON.stringify(refAfter));
  await shot(page, "after-report-390");
  const direct = await page.evaluate(async (body) => (await fetch("/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status,
    { requestKey: "e2e-after-report-0001", jobSheetId: sheet.id, productVersionId: sale1.productVersionId, guests: 1, expectedUnitPriceSatang: 20000, allocations: [{ bookingId: "any", guests: 1, fingerprint: "x".repeat(24) }] });
  check("and the API refuses a sale after the report (409)", direct === 409 && (await counts()).sales === 3, String(direct));
  await page.close();

  // ── an operator on the same job ──
  const ops = await browser.newPage();
  ops.on("pageerror", (e) => pageErrors.push(String(e)));
  await ops.setCookie(await sessionCookie(OPS));
  await goto(ops, JOB_PATH);
  check("an operator opening the job sees no Extras block and no Extras tick on the rows", !(await ops.$(".js-upsell")) && !(await ops.$(".ups-row-pick, .ups-row-sold")));
  const opsApi = await ops.evaluate(async (p) => (await fetch(p)).status, `/api/upsell/jobs/extras?guideId=${GUIDE_ID}&date=${TODAY}&slotIdx=${SLOT}`);
  const opsSell = await ops.evaluate(async () => (await fetch("/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  check("the API refuses an operator (403)", opsApi === 403 && opsSell === 403, `${opsApi} ${opsSell}`);
  await ops.close();

  check("no page error", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  const outbound = readFileSync(OUTBOUND, "utf8").trim();
  check("the server called nothing off this machine (no PEAK, no gateway)", outbound === "", outbound.slice(0, 300));
  const refRows = await moneyRowsReferencing();
  check("no PEAK outbox, guide payment or Company ADV row refers to this test's sales, payments, custody, job, Sale Refs or guide",
    refRows.sales === 3 && refRows.needles >= 3 * 2 + 3 + 3 + 3 && Object.values(refRows.refs).every((n) => n === 0), JSON.stringify(refRows));
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
